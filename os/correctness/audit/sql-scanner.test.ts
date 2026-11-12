/*
<MODULE_CONTRACT>
<purpose>RFC-1579 AC-7: the literal scanner — an interpolated SQL template is
counted unverifiable (severity info) and never fails the run; uppercase
keywords only (UI strings never match); comments are skipped; JSONC strip.</purpose>
<non-goals>
  <item>Not a contract source of truth — sql-scanner.ts owns behaviour.</item>
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
import { classifyStatement, scanStatements, stripJsonc, tableAccess } from "./sql-scanner.ts";
import { makeGitFixture, type GitFixture } from "./tests/git-fixture.ts";

const fixtures: GitFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));

describe("sql scanner", () => {
  it("AC-7: an interpolated SQL template counts as unverifiable without failing the run", async () => {
    const f = makeGitFixture();
    fixtures.push(f);
    f.write(
      "apps/api/src/dyn.ts",
      "export const q = (cols: string) => `SELECT ${cols} FROM openers WHERE missing_col = 1`;\n",
    );
    const out = await runCorrectnessAudit(f.root, { base: f.base });
    if (!out.ok) throw new Error(out.usageError);
    expect(out.result.unverifiable).toBeGreaterThanOrEqual(1);
    expect(out.result.findings.filter((x) => x.check === "sql.schema.conform")).toEqual([]);
    expect(out.result.status).toBe("pass");
  });

  it("matches uppercase SQL shapes only", () => {
    expect(classifyStatement("Update your profile")).toBeNull();
    expect(classifyStatement("Select a target")).toBeNull();
    expect(classifyStatement("SELECT id FROM t")).toBe("select");
    expect(classifyStatement("  INSERT OR IGNORE INTO t (a) VALUES (1)")).toBe("insert");
    expect(classifyStatement("UPDATE t SET a = 1")).toBe("update");
    expect(classifyStatement("DELETE FROM t")).toBe("delete");
    expect(classifyStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("with");
    expect(classifyStatement("SELECT the best option")).toBeNull();
  });

  it("skips comments, tracks lines, and marks interpolation", () => {
    const src =
      '// "SELECT a FROM ghost"\n/* `DELETE FROM ghost` */\nconst a = "SELECT id FROM t";\nconst b = `UPDATE t SET x = ${1}`;\n';
    const st = scanStatements("f.ts", src);
    expect(st.map((s) => [s.line, s.kind, s.interpolated])).toEqual([
      [3, "select", false],
      [4, "update", true],
    ]);
  });

  it("extracts table reads and writes", () => {
    const a = tableAccess("INSERT INTO log (id) SELECT id FROM openers JOIN candidates ON 1");
    expect([...a.writes]).toEqual(["log"]);
    expect([...a.reads].sort()).toEqual(["candidates", "openers"]);
    const d = tableAccess("DELETE FROM openers WHERE id IN (SELECT id FROM stale)");
    expect([...d.writes]).toEqual(["openers"]);
    expect([...d.reads]).toEqual(["stale"]);
  });

  it("strips JSONC comments and trailing commas but keeps strings", () => {
    const parsed = JSON.parse(stripJsonc('{ // c\n "a": "http://x", /* b */ "l": [1, 2,], }'));
    expect(parsed).toEqual({ a: "http://x", l: [1, 2] });
  });

  it("a quote or backtick inside a regex literal does not swallow later SQL", () => {
    const src = 'const re = /[`"]/g;\nconst q = "SELECT id FROM t";\n';
    expect(scanStatements("f.ts", src).map((s) => s.sql)).toEqual(["SELECT id FROM t"]);
  });
});
