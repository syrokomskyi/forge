/*
<MODULE_CONTRACT>
<purpose>RFC-1580 AC-7: in a tier high repository an oracle last changed by a commit without the verifier trailer pair is CORR-GATE-06, even when a review record covers it.</purpose>
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
void [L1_ORACLE, MOCK_ORACLE, ORACLE_PATH, lifecycleOracle, manifestYaml, reviewYaml, rules];

describe("tier high", () => {
  it("AC-7: a review-record-only oracle does not cover at tier high (CORR-GATE-06)", async () => {
    const r = await gate(fx({ tier: "high" }));
    const v = r.violations.find((x) => x.rule === "CORR-GATE-06");
    expect(v?.message, "tier high needs oracle bytes from the verifier").toMatch(
      /verifier-trailer commit/,
    );
    expect(r.status).toBe("fail");
  });

  it("a verifier-trailer oracle covers at tier high", async () => {
    const f = fx({ tier: "high" });
    f.write(ORACLE_PATH, `${L1_ORACLE}// from the verifier\n`);
    f.git(["add", "-A"]);
    f.git([
      "commit",
      "-qm",
      "test: verifier oracle\n\nX-Expectation-Origin: independent-verifier\nX-Verifier-Report: docs/correctness/reviews/r.yaml",
    ]);
    const r = await gate(f);
    expect(r.violations, JSON.stringify(r.violations)).toEqual([]);
  });

  it("tier formal without a non-self proof: oracle is CORR-GATE-06 and never runs a proof through checkRun", async () => {
    const f = fx({ tier: "high" });
    f.write("forge.yaml", f.read("forge.yaml").replace("tier: high", "tier: formal"));
    f.git(["add", "-A"]);
    f.git(["commit", "-qm", "formal"]);
    const out = await runCorrectnessGate(f.root, {
      base: f.git(["rev-parse", "HEAD"]),
      bundleDir: `${f.root}/.bundles`,
      proveSpec: async () => "proved",
    });
    if (!out.ok) throw new Error(out.usageError);
    expect(
      out.result.violations.some(
        (v) => v.rule === "CORR-GATE-06" && /non-self proof: oracle/.test(v.message),
      ),
    ).toBe(true);
  });
});
