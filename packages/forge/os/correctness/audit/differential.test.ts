/*
<MODULE_CONTRACT>
<purpose>RFC-1579 AC-3: differential attribution — a finding already present at
the base with the same occurrence count is `legacy`; a higher count is
`introduced`; a base-only finding is `resolved`; an allow-listed finding is
`accepted`; only introduced errors fail the run; --staged judges the index.</purpose>
<non-goals>
  <item>Not a contract source of truth — differential.ts owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial suite.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
  <item>RFC-1579: close review REVIEW-CODE-2026-11-13-01 findings

F1 INSERT 'has no column named' is a finding; F2 severity/kind escalation since base is introduced; F3 unparseable machine tables are errors; F4 comma joins, string literals and comments in table extraction; F5 only migration INSERT/REPLACE seed writes; F6 SET-clause-only coverage; F7 method-call writers; F8 regex literals in the scanner; F9 alias resolution; F10 EC-34 judges the payload only; F11 EC-34 before the scoped gates with a dry-run line; F12/F13 config and YAML errors named; F14 config-only check skips snapshots; F15 git grep failures fail closed; F16 portable prefilter; F17 shell no-ops; F18 shared D1 schemas; in-code DDL scoped per package; ledger tests. DEV-1..DEV-4 recorded in the RFC Deviations section.</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessAudit } from "./run.ts";
import { BASE_CODE, FORGE_YAML, makeGitFixture, type GitFixture } from "./tests/git-fixture.ts";

const fixtures: GitFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));

const BAD = `export const pending = (db: D1) => db.prepare("SELECT id FROM openers WHERE candidate_id = ?");\n`;
const BAD_TWICE =
  BAD +
  `export const again = (db: D1) => db.prepare("SELECT id FROM openers WHERE candidate_id = 1");\n`;

const conform = async (root: string, opts: Parameters<typeof runCorrectnessAudit>[1]) => {
  const out = await runCorrectnessAudit(root, opts);
  if (!out.ok) throw new Error(out.usageError);
  return {
    result: out.result,
    finding: out.result.findings.find((x) => x.check === "sql.schema.conform"),
  };
};

describe("differential attribution", () => {
  it("AC-3: a finding present at base with the same occurrence count is legacy and never blocks", async () => {
    const f = makeGitFixture({ "apps/api/src/legacy.ts": BAD });
    fixtures.push(f);
    f.write("apps/api/src/dispatch.ts", BASE_CODE + "\n// unrelated edit\n");
    const { result, finding } = await conform(f.root, { base: f.base });
    expect(finding?.attribution).toBe("legacy");
    expect(finding?.occurrences).toBe(1);
    expect(result.status, "legacy findings must not change the exit status").toBe("pass");
  });

  it("a higher occurrence count of a legacy subject is introduced", async () => {
    const f = makeGitFixture({ "apps/api/src/legacy.ts": BAD });
    fixtures.push(f);
    f.write("apps/api/src/legacy.ts", BAD_TWICE);
    const { result, finding } = await conform(f.root, { base: f.base });
    expect(finding?.attribution).toBe("introduced");
    expect(finding?.occurrences).toBe(2);
    expect(result.status).toBe("fail");
  });

  it("a base-only finding is resolved", async () => {
    const f = makeGitFixture({ "apps/api/src/legacy.ts": BAD });
    fixtures.push(f);
    f.write("apps/api/src/legacy.ts", "export {};\n");
    const { result, finding } = await conform(f.root, { base: f.base });
    expect(finding?.attribution).toBe("resolved");
    expect(result.status).toBe("pass");
  });

  it("an allow-listed finding is accepted", async () => {
    const allow = `${FORGE_YAML}correctness:\n  audit:\n    allow:\n      - check: sql.schema.conform\n        subject: "apps/api/src/new.ts:openers.candidate_id"\n        reason: "column added by an external system"\n`;
    const f = makeGitFixture({ "forge.yaml": allow });
    fixtures.push(f);
    f.write("apps/api/src/new.ts", BAD);
    const { result, finding } = await conform(f.root, { base: f.base });
    expect(finding?.attribution).toBe("accepted");
    expect(result.status).toBe("pass");
  });

  it("--staged judges the index against HEAD, ignoring unstaged edits", async () => {
    const f = makeGitFixture();
    fixtures.push(f);
    f.write("apps/api/src/new.ts", BAD);
    const unstaged = await conform(f.root, { staged: true });
    expect(unstaged.finding).toBeUndefined();
    f.git(["add", "apps/api/src/new.ts"]);
    const staged = await conform(f.root, { staged: true });
    expect(staged.finding?.attribution).toBe("introduced");
    expect(staged.result.base).toBe(f.base);
  });

  it("a finding whose severity or kind escalates since base is introduced (untouched → written-never-read)", async () => {
    const f = makeGitFixture({
      "apps/api/migrations/0002_a.sql": "CREATE TABLE assessments (id TEXT);\n",
    });
    fixtures.push(f);
    f.write(
      "apps/api/src/assess.ts",
      'export const w = "INSERT INTO assessments (id) VALUES (?)";\n',
    );
    const out = await runCorrectnessAudit(f.root, { base: f.base, check: "ledger.orphans" });
    if (!out.ok) throw new Error(out.usageError);
    const finding = out.result.findings.find(
      (x) => x.subject === "assessments" && x.attribution !== "resolved",
    );
    expect(finding?.message).toMatch(/^written-never-read/);
    expect(finding?.attribution, "a warning that became an error must block").toBe("introduced");
  });
});
