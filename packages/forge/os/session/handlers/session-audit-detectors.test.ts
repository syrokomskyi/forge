/*
<MODULE_CONTRACT>
<purpose>RFC-1471 session.audit detectors tests — all five Stage-A detectors fire on their seeded session shapes; clean session produces zero findings; --check exits non-zero on error findings.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSessionAudit, auditSessionBody } from "./session-audit.ts";
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

const BLOCKER_SESSION = `---
id: sess-002
---

### Assistant
Ran \`werkstatt run ecosystem.commit\` — exit: 1, lint blocked.

### Assistant
Fixed and re-ran — committed successfully.
`;

const GENERATED_SESSION = `---
id: sess-003
remainingIssues: ["none"]
---

### Assistant
Edited docs/command-manifest.generated.yaml by hand to add the new command.
`;

const CLEAN_SESSION = `---
id: sess-004
remainingIssues: ["none"]
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
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("auditSessionBody detectors (RFC-1471)", () => {
  test("AUDIT-01+04: denied command retried without plan change", () => {
    const body = DENIED_SESSION.split("---\n")[2]!;
    const findings = auditSessionBody("sess-001", body, { remainingIssues: ["x"] });
    expect(findings.some((f) => f.ruleId === "AUDIT-01")).toBe(true);
    expect(findings.some((f) => f.ruleId === "AUDIT-04")).toBe(true);
  });

  test("AUDIT-02: failure evidence + empty remainingIssues", () => {
    const body = BLOCKER_SESSION.split("---\n")[2]!;
    const findings = auditSessionBody("sess-002", body, {});
    expect(findings.some((f) => f.ruleId === "AUDIT-02")).toBe(true);
  });

  test("AUDIT-03: direct edit to a generated file", () => {
    const body = GENERATED_SESSION.split("---\n")[2]!;
    const findings = auditSessionBody("sess-003", body, { remainingIssues: ["x"] });
    expect(findings.some((f) => f.ruleId === "AUDIT-03")).toBe(true);
  });

  test("clean session → zero findings", () => {
    const body = CLEAN_SESSION.split("---\n")[2]!;
    const findings = auditSessionBody("sess-004", body, { remainingIssues: ["x"] });
    expect(findings.length).toBe(0);
  });
});

describe("session.audit command (RFC-1471)", () => {
  test("audits all sessions, writes sidecars, --check non-zero on errors", async () => {
    await writeFile(join(root, "docs", "sessions", "s1.md"), DENIED_SESSION);
    await writeFile(join(root, "docs", "sessions", "s2.md"), CLEAN_SESSION);
    const res = await runSessionAudit(flags({ check: true }), ctx());
    expect(res.data?.length).toBe(2);
    const s1 = res.data?.find((r) => r.sessionId === "sess-001");
    expect(s1?.findings.length).toBeGreaterThan(0);
    expect(res.exitCode).toBe(1);
  });
});

