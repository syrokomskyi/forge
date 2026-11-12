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
});
