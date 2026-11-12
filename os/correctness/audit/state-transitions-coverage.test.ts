/*
<MODULE_CONTRACT>
<purpose>RFC-1579 AC-5: `state.transitions.coverage` — a declared
`@state-machine[<name>]` edge whose target no declared writer receives is a
finding named `<machine>:<from>→<to>`; literal-argument calls, literal-tuple
loops, and SQL column literals cover a target; undeclared machines skip.</purpose>
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
import { makeGitFixture, type GitFixture } from "./tests/git-fixture.ts";

const fixtures: GitFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));

const MARK = "@state-" + "machine";
const EDGES = `// ${MARK}[candidate] (writers: transition) (column: state)
export const EDGES = [
  { from: "draft", to: "approved" },
  { from: "approved", to: "send_ready" },
  { from: "send_ready", to: "queued" },
];
export function transition(db: unknown, id: string, to: string) { return [db, id, to]; }
`;
const RECORD = `// ${MARK}[order] (writers: move)
export const ORDER: Record<string, string[]> = {
  open: ["paid"],
  paid: ["shipped", "refunded"],
};
`;

const coverage = async (files: Record<string, string>) => {
  const f = makeGitFixture();
  fixtures.push(f);
  for (const [rel, body] of Object.entries(files)) f.write(rel, body);
  const out = await runCorrectnessAudit(f.root, {
    base: f.base,
    check: "state.transitions.coverage",
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};

describe("state.transitions.coverage", () => {
  it("AC-5: an edge whose target no writer receives is reported by name", async () => {
    const result = await coverage({
      "packages/domain/src/candidate.ts": EDGES,
      "apps/api/src/review.ts":
        'import { transition } from "x";\nexport const go = (db: unknown) => transition(db, "c1", "approved");\n',
      "apps/api/src/queue.ts":
        "export const q = \"UPDATE candidates SET state = 'queued' WHERE id = ?\";\n",
    });
    const subjects = result.findings.map((x) => x.subject);
    expect(subjects, "approved→send_ready has no writer — defect #2's static half").toEqual([
      "candidate:approved→send_ready",
    ]);
    expect(result.findings[0]!.attribution).toBe("introduced");
    expect(result.findings[0]!.rule).toBe("CORR-AUDIT-03");
  });

  it("a literal tuple iterated into the writer covers every listed state", async () => {
    const result = await coverage({
      "packages/domain/src/candidate.ts": EDGES,
      "apps/api/src/dispatch2.ts":
        'export async function run(db: unknown) {\n  transition(db, "c", "approved");\n  for (const to of ["send_ready", "queued"] as const) {\n    await transition(db, "c", to);\n  }\n}\n',
    });
    expect(result.findings).toEqual([]);
  });

  it("Record<State, State[]> tables are audited too", async () => {
    const result = await coverage({
      "apps/api/src/order.ts": RECORD,
      "apps/api/src/pay.ts":
        'export const p = () => { move("o", "paid"); move("o", "shipped"); };\n',
    });
    expect(result.findings.map((x) => x.subject)).toEqual(["order:paid→refunded"]);
  });

  it("without a declared machine the auditor reports a skip", async () => {
    const result = await coverage({});
    expect(result.skipped).toContain("state.transitions.coverage: no-declared-machine");
  });

  it("a marker without a parseable table is reported, never a silent pass", async () => {
    const result = await coverage({
      "apps/api/src/m.ts": `// ${MARK}[broken] (writers: go)\nexport const T = new Map([["a", "b"]]);\n`,
    });
    expect(result.findings.map((x) => x.subject)).toEqual(["broken:unparseable-table"]);
  });

  it("method-call writers cover; a WHERE clause from-state does not", async () => {
    const result = await coverage({
      "packages/domain/src/candidate.ts": EDGES,
      "apps/api/src/svc.ts":
        'export const run = (repo: any) => { repo.transition(db, "c", "approved"); repo.transition(db, "c", "queued"); };\n' +
        "export const q = \"UPDATE candidates SET updated_at = 1 WHERE state = 'send_ready'\";\n",
    });
    expect(result.findings.map((x) => x.subject)).toEqual(["candidate:approved→send_ready"]);
  });
});
