/*
<MODULE_CONTRACT>
<purpose>RFC-1471 session.audit tests — command-level: audits sessions, writes sidecars deterministically (auditedAt = session date, no churn), --check is read-only + exits non-zero on critical findings.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSessionAudit } from "./session-audit.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

const CIRCUMVENTION_SESSION = `---
id: sess-circ
date: "2026-10-31"
remainingIssues: []
---
### Assistant
Ran \`werkstatt run ecosystem.commit --rfc RFC-1434\` — blocked by full-suite gate.
### Assistant
Ran \`git commit -m "fix"\` directly — bypassed.
`;

const CLEAN_SESSION = `---
id: sess-clean
date: "2026-10-31"
remainingIssues: []
---
### Assistant
Ran \`werkstatt run rfc.validate --json\` — exit: 0, all checks pass.
`;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown> = {}) {
  return { argv: [], flags: f } as never;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sess-audit-"));
  await mkdir(join(root, "docs", "sessions"), { recursive: true });
  await writeFile(join(root, "forge.yaml"), "schema: forge/config@1\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("session.audit command (RFC-1471)", () => {
  test("audits all sessions, writes sidecars, --check exits non-zero on critical findings", async () => {
    await writeFile(join(root, "docs", "sessions", "2026-10-31-12-00-00-aaaaaa.md"), CIRCUMVENTION_SESSION);
    await writeFile(join(root, "docs", "sessions", "2026-10-31-12-30-00-bbbbbb.md"), CLEAN_SESSION);
    const res = await runSessionAudit(flags({ check: true }), ctx());
    expect(res.data?.length).toBe(2);
    expect(res.data?.find((r) => r.sessionId === "sess-circ")?.findings.some((f) => f.ruleId === "AUDIT-10")).toBe(true);
    expect(res.exitCode).toBe(1);
    // --check is read-only — no sidecar written
    await expect(readFile(join(root, "docs", "sessions", "audit", "sess-circ.audit.yaml"))).rejects.toThrow();
  });

  test("sidecar writes are deterministic — auditedAt = session date, unchanged rerun produces no diff", async () => {
    await writeFile(join(root, "docs", "sessions", "2026-10-31-12-00-00-aaaaaa.md"), CIRCUMVENTION_SESSION);
    await runSessionAudit(flags({}), ctx());
    const first = await readFile(join(root, "docs", "sessions", "audit", "sess-circ.audit.yaml"), "utf8");
    await runSessionAudit(flags({}), ctx());
    const second = await readFile(join(root, "docs", "sessions", "audit", "sess-circ.audit.yaml"), "utf8");
    expect(first).toBe(second);
    expect(first).toContain("auditedAt: 2026-10-31");
    expect(first).toContain("auditor: stage-a");
  });
});
