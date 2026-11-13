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
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
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
  verifierCommit,
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
void [
  L1_ORACLE,
  MOCK_ORACLE,
  ORACLE_PATH,
  lifecycleOracle,
  manifestYaml,
  reviewYaml,
  verifierCommit,
];

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

  it("a review record committed by the verifier workflow makes it verified", async () => {
    const f = fx();
    addEntry(f);
    f.commit("add entry with its oracle");
    const rel = "docs/correctness/reviews/2026-11-13-new.yaml";
    f.write(rel, reviewYaml([{ check: `test:${NEW_ORACLE}`, content: L1_ORACLE }]));
    verifierCommit(f.git, rel);
    const r = await gate(f);
    expect(rules(r)).not.toContain("CORR-GATE-03");
  });

  it("a review record the implementer commits without the verifier trailer pair does not count", async () => {
    const f = fx();
    addEntry(f);
    f.write(
      "docs/correctness/reviews/2026-11-13-new.yaml",
      reviewYaml([{ check: `test:${NEW_ORACLE}`, content: L1_ORACLE }]),
    );
    f.commit("add entry, oracle, and its review");
    expect(rules(await gate(f)), "a self-written record must never verify an oracle").toContain(
      "CORR-GATE-03",
    );
  });

  it("a verifier commit whose X-Verifier-Report names another file does not count", async () => {
    const f = fx();
    addEntry(f);
    f.commit("add entry");
    f.write(
      "docs/correctness/reviews/2026-11-13-new.yaml",
      reviewYaml([{ check: `test:${NEW_ORACLE}`, content: L1_ORACLE }]),
    );
    verifierCommit(f.git, "docs/correctness/reviews/other.yaml");
    expect(rules(await gate(f))).toContain("CORR-GATE-03");
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
