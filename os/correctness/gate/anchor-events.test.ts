/*
<MODULE_CONTRACT>
<purpose>RFC-1580 AC-6: a lifecycle oracle whose forge.anchor event references a row value the attested database does not hold is CORR-GATE-05; a matching event covers.</purpose>
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
void [L1_ORACLE, MOCK_ORACLE, ORACLE_PATH, lifecycleOracle, manifestYaml, reviewYaml, rules];

describe("anchor events", () => {
  it("AC-6: an event claiming a state the database does not hold is CORR-GATE-05", async () => {
    const r = await gate(
      fx({ seam: "lifecycle", substrate: "L2", oracle: lifecycleOracle("send_ready") }),
    );
    const v = r.violations.find((x) => x.rule === "CORR-GATE-05");
    expect(
      v?.message,
      "a log line must not claim a transition that never reached the database",
    ).toMatch(/candidates.state is "queued", event claims "send_ready"/);
    expect(r.status).toBe("fail");
  });

  it("a verified event covers the lifecycle entry", async () => {
    const r = await gate(
      fx({ seam: "lifecycle", substrate: "L2", oracle: lifecycleOracle("queued") }),
    );
    expect(r.violations, JSON.stringify(r.violations)).toEqual([]);
  });

  it("an L2 run without any anchor event is CORR-GATE-05", async () => {
    const r = await gate(
      fx({ seam: "lifecycle", substrate: "L2", oracle: L1_ORACLE.replace('"L1"', '"L2"') }),
    );
    expect(r.violations.find((x) => x.rule === "CORR-GATE-05")?.message).toMatch(
      /no verified forge.anchor event for INV-dispatch-01/,
    );
  });
});
