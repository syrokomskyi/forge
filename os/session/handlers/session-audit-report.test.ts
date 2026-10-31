/*
<MODULE_CONTRACT>
<purpose>RFC-1471 session.audit.report tests — sidecar aggregation + unlinked finding classes.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSessionAudit } from "./session-audit.ts";
import { runSessionAuditReport } from "./session-audit-report.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

const DENIED_SESSION = `---
id: sess-001
remainingIssues: ["a blocker"]
---

### Assistant
Ran \`werkstatt run rfc.validate --json\` — rejected: staged files outside scope.

### Assistant
Ran \`werkstatt run rfc.validate --json\` again — same failure.
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
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("session.audit.report (RFC-1471)", () => {
  test("aggregates sidecars + reports unlinked finding classes", async () => {
    await writeFile(join(root, "docs", "sessions", "s1.md"), DENIED_SESSION);
    await runSessionAudit(flags({}), ctx());
    const res = await runSessionAuditReport(flags({}), ctx());
    expect(res.data?.sessionsAudited).toBeGreaterThan(0);
    expect(res.data?.byRule.some((r) => r.ruleId === "AUDIT-01")).toBe(true);
    expect(res.data?.unlinkedFindings).toContain("AUDIT-01");
  });
});
