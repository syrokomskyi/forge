/*
<MODULE_CONTRACT>
<purpose>RFC-1579 AC-4: `ledger.orphans` — a table statements insert into but
never select from is a `written-never-read` error with subject = table; a
read-only table is `read-never-written`; an untouched table only warns;
migration INSERTs count as writes.</purpose>
<non-goals>
  <item>Not a contract source of truth — the auditor owns behaviour.</item>
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
import { BASE_CODE, MIGRATION, makeGitFixture, type GitFixture } from "./tests/git-fixture.ts";

const fixtures: GitFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));

const orphans = async (files: Record<string, string>) => {
  const f = makeGitFixture();
  fixtures.push(f);
  for (const [rel, body] of Object.entries(files)) f.write(rel, body);
  const out = await runCorrectnessAudit(f.root, { base: f.base, check: "ledger.orphans" });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};

describe("ledger.orphans", () => {
  it("AC-4: a table inserted into but never selected from is a written-never-read error named by the table", async () => {
    const result = await orphans({
      "apps/api/migrations/0002_ledger.sql":
        "CREATE TABLE sent_log (id TEXT PRIMARY KEY, at TEXT);\n",
      "apps/api/src/log.ts": 'export const log = "INSERT INTO sent_log (id, at) VALUES (?, ?)";\n',
    });
    const f = result.findings.find((x) => x.subject === "sent_log");
    expect(f, "a published ledger that nothing reads must be reported").toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toMatch(/^written-never-read/);
    expect(f!.attribution).toBe("introduced");
    expect(f!.rule).toBe("CORR-AUDIT-02");
  });

  it("read-never-written is an error; untouched is a warning; tables with both are quiet", async () => {
    const result = await orphans({
      "apps/api/migrations/0002_more.sql":
        "CREATE TABLE assessments (id TEXT);\nCREATE TABLE knowledge_items (id TEXT);\n",
      "apps/api/src/read.ts": 'export const r = "SELECT id FROM assessments";\n',
    });
    const by = new Map(result.findings.map((x) => [x.subject, x]));
    expect(by.get("assessments")?.message).toMatch(/^read-never-written/);
    expect(by.get("knowledge_items")?.severity).toBe("warning");
    expect(by.get("knowledge_items")?.message).toMatch(/^untouched/);
    expect(by.has("openers")).toBe(false);
    expect(by.has("candidates")).toBe(false);
  });

  it("a migration INSERT counts as a write", async () => {
    const result = await orphans({
      "apps/api/migrations/0002_seed.sql":
        "CREATE TABLE plans (id TEXT);\nINSERT INTO plans (id) VALUES ('free');\n",
      "apps/api/src/plans.ts": 'export const p = "SELECT id FROM plans";\n',
    });
    expect(result.findings.find((x) => x.subject === "plans")).toBeUndefined();
  });

  it("the fixture's base tables are covered (sanity)", () => {
    expect(BASE_CODE).toMatch(/INSERT INTO openers/);
    expect(MIGRATION).toMatch(/CREATE TABLE candidates/);
  });

  it("comma joins read every table; string literals and migration UPDATEs never count", async () => {
    const result = await orphans({
      "apps/api/migrations/0002_x.sql":
        "CREATE TABLE legacy (id TEXT);\nCREATE TABLE audit_log (id TEXT);\nUPDATE audit_log SET id = id;\n",
      "apps/api/src/x.ts":
        "export const r = \"SELECT o.id FROM openers o, candidates c WHERE c.state = 'copied from legacy'\";\n",
    });
    const by = new Map(result.findings.map((x) => [x.subject, x]));
    expect(by.get("legacy")?.message, "a quoted 'from legacy' is not a read").toMatch(/^untouched/);
    expect(by.get("audit_log")?.message, "a migration UPDATE is not a seeding write").toMatch(
      /^untouched/,
    );
    expect(by.has("candidates")).toBe(false);
  });
});
