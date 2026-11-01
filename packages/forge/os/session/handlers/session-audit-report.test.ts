/*
<MODULE_CONTRACT>
<purpose>RFC-1471 session.audit.report tests — sidecar aggregation into docs/metrics/session-audit.generated.yaml, --window filter, unlinked finding classes.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSessionAudit } from "./session-audit.ts";
import { runSessionAuditReport } from "./session-audit-report.ts";
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
  root = await mkdtemp(join(tmpdir(), "sess-report-"));
  await mkdir(join(root, "docs", "sessions"), { recursive: true });
  await mkdir(join(root, "docs", "metrics"), { recursive: true });
  await writeFile(join(root, "forge.yaml"), "schema: forge/config@1\n");
  await writeFile(join(root, "docs", "frictions.yaml"), "frictions: []\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("session.audit.report (RFC-1471)", () => {
  test("aggregates sidecars into the metrics artifact + reports unlinked finding classes", async () => {
    await writeFile(join(root, "docs", "sessions", "2026-10-31-12-00-00-aaaaaa.md"), CIRCUMVENTION_SESSION);
    await runSessionAudit(flags({}), ctx());
    const res = await runSessionAuditReport(flags({}), ctx());
    expect(res.data?.sessionsAudited).toBe(1);
    expect(res.data?.verdicts.violations).toBe(1);
    expect(res.data?.byRule.some((r) => r.ruleId === "AUDIT-10")).toBe(true);
    expect(res.data?.unlinkedFindings).toContain("AUDIT-10");
    const metrics = await readFile(join(root, "docs", "metrics", "session-audit.generated.yaml"), "utf8");
    expect(metrics).toContain("AUDIT-10");
  });
});
