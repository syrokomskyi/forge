/*
<MODULE_CONTRACT>
<purpose>RFC-1580 AC-9: an oracle added in the session without a committed forge/oracle-review@1 record naming its current sha256 is self — CORR-GATE-03 for its entry; a record with a stale hash does not count.</purpose>
<non-goals>
  <item>Not a contract source of truth — gate/run.ts owns behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial suite.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
</CHANGE_SUMMARY>
*/

import { afterEach, describe, expect, it } from "vitest";

import { runCorrectnessGate } from "./run.ts";
import {
  L1_ORACLE,
  MOCK_ORACLE,
  ORACLE_PATH,
  lifecycleOracle,
  makeGateFixture,
  manifestYaml,
  reviewYaml,
  type GateFixture,
} from "./tests/gate-fixture.ts";

const fixtures: GateFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fx = (o: Parameters<typeof makeGateFixture>[0] = {}) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};
const gate = async (f: GateFixture, acceptWeakening?: string) => {
  const out = await runCorrectnessGate(f.root, {
    base: f.base,
    bundleDir: `${f.root}/.bundles`,
    acceptWeakening,
  });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};
const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);
void [L1_ORACLE, MOCK_ORACLE, ORACLE_PATH, lifecycleOracle, manifestYaml, reviewYaml];

const NEW_ORACLE = "test/new.oracle.ts";
const NEW_ENTRY = `  - id: CM-dispatch-02
    source: req
    ref: REQ-01
    seam: data
    anchors: [INV-dispatch-01]
    oracles:
      - check: test:${NEW_ORACLE}
        substrate: L1
`;
const addEntry = (f: GateFixture) => {
  f.write(NEW_ORACLE, L1_ORACLE);
  f.write(
    "apps/api/src/dispatch.ts",
    f
      .read("apps/api/src/dispatch.ts")
      .replace(
        `(checked-by: test:${ORACLE_PATH})`,
        `(checked-by: test:${ORACLE_PATH}, test:${NEW_ORACLE})`,
      ),
  );
  f.write("docs/correctness.yaml", manifestYaml({}, NEW_ENTRY));
};

describe("oracle origin", () => {
  it("AC-9: a session-added oracle without a review record is self (CORR-GATE-03)", async () => {
    const f = fx();
    addEntry(f);
    f.commit("add entry with its oracle");
    const r = await gate(f);
    const v = r.violations.find((x) => x.rule === "CORR-GATE-03");
    expect(v?.entry, "a self oracle never covers").toBe("CM-dispatch-02");
    expect(r.status).toBe("fail");
  });

  it("a committed review record naming the current sha256 makes it verified", async () => {
    const f = fx();
    addEntry(f);
    f.write(
      "docs/correctness/reviews/2026-11-13-new.yaml",
      reviewYaml([{ check: `test:${NEW_ORACLE}`, content: L1_ORACLE }]),
    );
    f.commit("add entry, oracle, and its review");
    const r = await gate(f);
    expect(rules(r)).not.toContain("CORR-GATE-03");
  });

  it("a review record with a stale hash does not count", async () => {
    const f = fx();
    addEntry(f);
    f.write(
      "docs/correctness/reviews/2026-11-13-new.yaml",
      reviewYaml([{ check: `test:${NEW_ORACLE}`, content: "old bytes" }]),
    );
    f.commit("add entry with a stale review");
    expect(rules(await gate(f))).toContain("CORR-GATE-03");
  });
});
