/*
<MODULE_CONTRACT>
<purpose>RFC-1579 AC-2: a TypeScript SQL literal new since the base revision
that names a column the migration DDL does not declare is an introduced
`sql.schema.conform` error; package-scoped schemas; failing migrations.</purpose>
<non-goals>
  <item>Not a contract source of truth — the auditor owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial suite.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
  <item>RFC-1579: gate line, ecosystem.commit early run, reference page

typescript profile integration-gate.sh runs the primary install's correctness.audit against FLOW_BASE_SHA; werkstatt ecosystem.commit gains EC-34 (correctness.audit --staged, refuses introduced CORR-AUDIT-01..03, warns on CORR-AUDIT-04); in-code CREATE TABLE tables (Durable Object storage) are unverifiable instead of D1 findings; correctness.audit declares generates: []; reference page and agent guides.

Measured on werkstatt (rollout step 3): 7 wrangler D1 configs, ~10 s per run, 3 legacy sql.schema.conform findings (packages/warpgogol-billing-cloudflare against schemas outside the repo), 127 unverifiable statements, no state machines; CORR-AUDIT-04 present (verify equals test) — fixed by the werkstatt gate-wiring queue task.</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessAudit } from "./run.ts";
import { BASE_CODE, makeGitFixture, type GitFixture } from "./tests/git-fixture.ts";

const fixtures: GitFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fixture = (files?: Record<string, string>) => {
  const f = makeGitFixture(files);
  fixtures.push(f);
  return f;
};

const BAD_QUERY = `\nexport const pending = (db: D1) => db.prepare("SELECT id FROM openers WHERE candidate_id = ?");\n`;

describe("sql.schema.conform", () => {
  it("AC-2: a new literal naming an undeclared column is an introduced error", async () => {
    const f = fixture();
    f.write("apps/api/src/dispatch.ts", BASE_CODE + BAD_QUERY);
    const out = await runCorrectnessAudit(f.root, { base: f.base });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const finding = out.result.findings.find((x) => x.check === "sql.schema.conform");
    expect(
      finding,
      "openers.candidate_id is declared by no migration — the auditor must name it",
    ).toBeDefined();
    expect(finding!.subject).toBe("apps/api/src/dispatch.ts:openers.candidate_id");
    expect(finding!.attribution).toBe("introduced");
    expect(finding!.severity).toBe("error");
    expect(finding!.rule).toBe("CORR-AUDIT-01");
    expect(finding!.location?.line).toBe(8); // BASE_CODE is 6 lines + blank separator
    expect(out.result.status).toBe("fail");
  });

  it("a missing table is a finding; a valid statement is not", async () => {
    const f = fixture();
    f.write(
      "apps/api/src/extra.ts",
      'export const q = "SELECT id FROM assessments";\nexport const ok = "SELECT id FROM openers";\n',
    );
    const out = await runCorrectnessAudit(f.root, { base: f.base });
    if (!out.ok) throw new Error(out.usageError);
    const subjects = out.result.findings
      .filter((x) => x.check === "sql.schema.conform")
      .map((x) => x.subject);
    expect(subjects).toEqual(["apps/api/src/extra.ts:assessments"]);
  });

  it("a statement in a shared package is checked against every schema", async () => {
    const f = fixture();
    f.write(
      "packages/domain/src/q.ts",
      'export const q = "SELECT target FROM openers";\nexport const bad = "SELECT nope FROM openers";\n',
    );
    const out = await runCorrectnessAudit(f.root, { base: f.base });
    if (!out.ok) throw new Error(out.usageError);
    const subjects = out.result.findings
      .filter((x) => x.check === "sql.schema.conform")
      .map((x) => x.subject);
    expect(subjects).toEqual(["packages/domain/src/q.ts:openers.nope"]);
  });

  it("a migration that fails to apply is an error on the migration file, never a partial schema", async () => {
    const f = fixture();
    f.write("apps/api/migrations/0002_broken.sql", "ALTER TABLE ghosts ADD COLUMN x TEXT;\n");
    const out = await runCorrectnessAudit(f.root, { base: f.base });
    if (!out.ok) throw new Error(out.usageError);
    const finding = out.result.findings.find(
      (x) => x.subject === "apps/api/migrations/0002_broken.sql",
    );
    expect(finding?.attribution).toBe("introduced");
    expect(out.result.findings.filter((x) => x.subject.startsWith("apps/api/src/"))).toEqual([]);
  });

  it("test files are not scanned and a repository without D1 is skipped", async () => {
    const f = fixture();
    f.write("apps/api/src/dispatch.test.ts", BAD_QUERY);
    const out = await runCorrectnessAudit(f.root, { base: f.base });
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.findings.filter((x) => x.check === "sql.schema.conform")).toEqual([]);

    const bare = fixture({ "apps/api/wrangler.jsonc": "{}\n" });
    const res = await runCorrectnessAudit(bare.root, { base: bare.base });
    if (!res.ok) throw new Error(res.usageError);
    expect(res.result.skipped).toContain("sql.schema.conform: no-d1");
    expect(res.result.skipped).toContain("ledger.orphans: no-d1");
  });

  it("statements on tables an in-code CREATE TABLE literal creates are unverifiable, not findings", async () => {
    const f = fixture();
    f.write(
      "packages/storage/src/do.ts",
      'export const ddl = "CREATE TABLE IF NOT EXISTS journal_entries (id TEXT)";\nexport const q = "SELECT id FROM journal_entries";\n',
    );
    const out = await runCorrectnessAudit(f.root, { base: f.base });
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.findings.filter((x) => x.check === "sql.schema.conform")).toEqual([]);
    expect(out.result.unverifiable).toBeGreaterThanOrEqual(1);
  });

  it("an unresolvable --base is a usage error", async () => {
    const f = fixture();
    const out = await runCorrectnessAudit(f.root, { base: "no-such-ref" });
    expect(out.ok).toBe(false);
  });
});
