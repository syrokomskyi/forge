/*
<MODULE_CONTRACT>
<purpose>RFC-1580 AC-8: correctness.mode semantics at the gate — warn mode
turns CORR-GATE-03..08 into warnings and passes; a covered entry passes in
enforce; exempt short-circuits.</purpose>
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
import { makeGateFixture, type GateFixture } from "./tests/gate-fixture.ts";

const fixtures: GateFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const fx = (o: Parameters<typeof makeGateFixture>[0]) => {
  const f = makeGateFixture(o);
  fixtures.push(f);
  return f;
};
const gate = async (f: GateFixture) => {
  const out = await runCorrectnessGate(f.root, { base: f.base, bundleDir: `${f.root}/.bundles` });
  if (!out.ok) throw new Error(out.usageError);
  return out.result;
};

describe("gate mode", () => {
  it("a reviewed, attested L1 oracle covers its data entry in enforce mode", async () => {
    const r = await gate(fx({}));
    expect(r.violations, JSON.stringify(r.violations)).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("AC-8: in warn mode CORR-GATE-03..08 are warnings and the gate passes", async () => {
    const f = fx({ mode: "warn", oracle: "process.exit(1);\n" });
    const r = await gate(f);
    const rules = new Set(r.violations.map((v) => v.rule));
    expect(rules.has("CORR-GATE-07"), "the failing oracle must still be reported").toBe(true);
    expect(r.violations.every((v) => v.severity === "warning")).toBe(true);
    expect(r.status).toBe("pass");
  });

  it("the same failure refuses in enforce mode", async () => {
    const r = await gate(fx({ oracle: "process.exit(1);\n" }));
    expect(r.violations.find((v) => v.rule === "CORR-GATE-07")?.severity).toBe("error");
    expect(r.status).toBe("fail");
  });
});

describe("frozen exempt mode", () => {
  it("a session that switches its repository to exempt is refused, not exempted", async () => {
    const f = fx({});
    f.write(
      "forge.yaml",
      f
        .read("forge.yaml")
        .replace("mode: enforce", "mode: exempt")
        .replace("    correctnessManifest: docs/correctness.yaml\n", ""),
    );
    f.commit("exempt myself");
    const r = await gate(f);
    expect(r.status).toBe("fail");
    expect(r.violations.some((v) => v.rule === "CORR-GATE-02" && /to exempt/.test(v.message))).toBe(
      true,
    );
  });
});
