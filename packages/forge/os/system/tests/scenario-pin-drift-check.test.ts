/*
<MODULE_CONTRACT>
<purpose>RFC-1541 AC-7..AC-13 — the warning-only pin-drift check against a fake npm, pin-bump proposals in system.outbox.scan, and the authority lint.</purpose>
<non-goals><item>No real registry.</item></non-goals>
</MODULE_CONTRACT>
*/
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { runSystemVersionSetRecord } from "../handlers/system-versionset-record.ts";
import { runSystemOutboxScan } from "../handlers/system-outbox-scan.ts";
import { runSystemMapValidate } from "../handlers/system-map-validate.ts";
import { makeContext } from "./helpers.ts";
import { SPEC_PKG, TAG, fakeNpm, scenario, specConsumer, systemWith } from "./contract-fixtures.ts";

const VERSIONS = ["0.1.5", "0.1.6", "0.1.7", "0.1.8", "0.1.9", "0.1.10"];
const drift = (authority = "alpha", contract = "demo-spec") =>
  `  - product: beta\n    argv: ["${process.execPath}", "-e", "0"]\n  - kind: pin-drift\n    contract: ${contract}\n    package: "${SPEC_PKG}"\n    authority: ${authority}\n    maxLag: 3\n`;

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

async function recordWith(pinned: string, npm: Parameters<typeof fakeNpm>[0]) {
  restore = await fakeNpm(npm);
  const beta = await specConsumer(pinned);
  const root = await systemWith(
    { beta },
    { "system/scenarios/d.yaml": scenario("d", ["beta"], drift()) },
  );
  const res = await runSystemVersionSetRecord(
    { argv: [], flags: { products: `beta=${TAG}`, scenarios: "d" } },
    makeContext(root),
  );
  return { root, res };
}

describe("pin-drift check kind (RFC-1541)", () => {
  it("AC-7: warns W01 for a consumer three published versions behind", async () => {
    const { res } = await recordWith("0.1.7", { versions: VERSIONS, latest: "0.1.10" });
    expect(res.data!.warnings).toContainEqual(
      expect.objectContaining({
        code: "SYSTEM-VS-W01",
        product: "beta",
        from: "0.1.7",
        to: "0.1.10",
      }),
    );
  });

  it("AC-8: stays silent for a consumer two versions behind", async () => {
    const { res } = await recordWith("0.1.8", { versions: VERSIONS, latest: "0.1.10" });
    expect(res.data!.warnings).toEqual([]);
  });

  it("AC-9: the record succeeds in both drift cases", async () => {
    for (const pinned of ["0.1.7", "0.1.8"]) {
      const { res } = await recordWith(pinned, { versions: VERSIONS, latest: "0.1.10" });
      expect(res.exitCode, pinned).toBe(0);
      expect(res.data!.created, pinned).toBe(true);
      restore?.();
      restore = null;
    }
  });

  it("AC-10: an unreachable registry emits W02 and still records", async () => {
    const { res } = await recordWith("0.1.7", { offline: true });
    expect(res.data!.warnings.map((w) => w.code)).toEqual(["SYSTEM-VS-W02"]);
    expect(res.data!.created).toBe(true);
  });

  it("an unlisted pin is reported as W01 instead of crashing", async () => {
    const { res } = await recordWith("0.0.1", { versions: VERSIONS, latest: "0.1.10" });
    expect(res.data!.warnings[0]!.message).toContain("does not list");
  });

  it("AC-11: system.outbox.scan lists one pin-bump proposal per W01 warning", async () => {
    const { root } = await recordWith("0.1.7", { versions: VERSIONS, latest: "0.1.10" });
    const scan = await runSystemOutboxScan({ argv: [], flags: {} }, makeContext(root));
    expect(scan.data!.pinBumps).toEqual([
      {
        kind: "pin-bump",
        versionSet: "VS-0001",
        product: "beta",
        package: SPEC_PKG,
        from: "0.1.7",
        to: "0.1.10",
      },
    ]);
  });

  it("AC-12: --create materializes no task for a pin-bump proposal", async () => {
    const { root } = await recordWith("0.1.7", { versions: VERSIONS, latest: "0.1.10" });
    const scan = await runSystemOutboxScan(
      { argv: [], flags: { create: true } },
      makeContext(root),
    );
    expect(scan.data!.pinBumps).toHaveLength(1);
    expect(scan.data!.created).toEqual([]);
  });

  it("AC-13: map.validate rejects a pin-drift whose authority does not offer the contract", async () => {
    const beta = await specConsumer("0.1.9");
    const root = await systemWith(
      { beta },
      { "system/scenarios/d.yaml": scenario("d", ["beta"], drift("beta")) },
    );
    const res = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(res.data!.diagnostics).toContainEqual(
      expect.objectContaining({ ruleId: "SYSTEM-MAP-07", severity: "error" }),
    );
  });
});
