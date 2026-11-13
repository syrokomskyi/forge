/*
<MODULE_CONTRACT>
<purpose>RFC-1580 AC-3: deleting a manifest entry present at the base revision is CORR-GATE-02 and refuses in warn mode as well; an isolated weakening session can be accepted.</purpose>
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

describe("frozen-set diff", () => {
  it("AC-3: a deleted base entry is CORR-GATE-02 and refuses in warn mode too", async () => {
    const f = fx({ mode: "warn" });
    f.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    f.commit("drop the entry");
    const r = await gate(f);
    const v = r.violations.find((x) => x.rule === "CORR-GATE-02");
    expect(v?.message, "deleting a frozen entry is a weakening").toMatch(
      /entry CM-dispatch-01 was deleted/,
    );
    expect(v?.severity).toBe("error");
    expect(r.status).toBe("fail");
  });

  it("a lowered substrate, an added unverifiable exemption, and a repointed checkRun are weakenings", async () => {
    const f = fx();
    f.write(
      "docs/correctness.yaml",
      manifestYaml({ substrate: "L1" })
        .replace("substrate: L1", "substrate: L0")
        .replace(
          "exemptions: []",
          'exemptions:\n  - ref: REQ-01\n    kind: unverifiable\n    reason: "nope"',
        ),
    );
    f.write(
      "forge.yaml",
      f.read("forge.yaml").replace('checkRun: "node {file}"', 'checkRun: "true {file}"'),
    );
    f.commit("weaken");
    const msgs = (await gate(f)).violations
      .filter((x) => x.rule === "CORR-GATE-02")
      .map((x) => x.message);
    expect(msgs.some((m) => /substrate lowered from L1 to L0/.test(m))).toBe(true);
    expect(msgs.some((m) => /unverifiable exemption added for REQ-01/.test(m))).toBe(true);
    expect(msgs.some((m) => /bindings.commands.checkRun changed/.test(m))).toBe(true);
  });

  it("--accept-weakening passes an isolated weakening session and refuses a mixed one", async () => {
    const f = fx({ mode: "warn" });
    f.write(
      "docs/correctness.yaml",
      "schema: forge/correctness-manifest@1\nentries: []\nsupport: []\nexemptions: []\n",
    );
    f.commit("drop the entry");
    const isolated = await gate(f, "operator: entry retired with REQ-01");
    expect(rules(isolated)).not.toContain("CORR-GATE-02");
    expect(isolated.acceptedWeakening).toBe("operator: entry retired with REQ-01");
    f.write("apps/api/src/other.ts", "export const x = 1;\n");
    f.commit("unrelated change");
    const mixed = await gate(f, "operator: entry retired with REQ-01");
    expect(mixed.violations.find((x) => x.rule === "CORR-GATE-02")?.message).toMatch(
      /mixed-weakening/,
    );
  });
});
