/*
<MODULE_CONTRACT>
<purpose>RFC-1541 AC-1..AC-3 — version-set@2 contracts resolved from root lockfile importers; @1 files stay readable; SYSTEM-VS-06.</purpose>
<non-goals><item>Check kinds are covered by the validator/pin-drift test files.</item></non-goals>
</MODULE_CONTRACT>
*/
// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { runSystemVersionSetRecord } from "../handlers/system-versionset-record.ts";
import { lockfileVersion } from "../handlers/system-versionset-record.ts";
import { versionSetSchema } from "../scenario-schemas.ts";
import { makeContext } from "./helpers.ts";
import { SPEC_PKG, TAG, scenario, specConsumer, systemWith } from "./contract-fixtures.ts";

const ok = `  - product: beta\n    argv: ["${process.execPath}", "-e", "0"]\n`;

describe("version-set@2 (RFC-1541)", () => {
  it("AC-1: records contracts from the tag's root lockfile importer, peer suffix stripped", async () => {
    const beta = await specConsumer("0.1.9");
    const root = await systemWith(
      { beta },
      { "system/scenarios/s.yaml": scenario("s", ["beta"], ok) },
    );
    const res = await runSystemVersionSetRecord(
      { argv: [], flags: { products: `beta=${TAG}`, scenarios: "s" } },
      makeContext(root),
    );
    expect(res.exitCode).toBe(0);
    const set = YAML.parse(
      await readFile(path.join(root, "system/version-sets/VS-0001.yaml"), "utf8"),
    );
    expect(set.schema).toBe("forge/version-set@2");
    expect(set.contracts).toEqual({ beta: { [SPEC_PKG]: "0.1.9" } });
    expect(set.warnings).toEqual([]);
    expect(versionSetSchema.safeParse(set).success).toBe(true);
  });

  it("AC-2: an existing @1 set (VS-0002 shape) still parses", () => {
    const v1 = {
      schema: "forge/version-set@1",
      id: "VS-0002",
      products: { werkstatt: "v6.458.1", lagebild: "v0.1.1" },
      scenarios: ["verbund-spec-conformance"],
      evidence: { "verbund-spec-conformance": `sha256:${"0".repeat(64)}` },
      verifiedAt: "2026-11-05T11:49:07.870Z",
    };
    expect(versionSetSchema.safeParse(v1).success).toBe(true);
  });

  it("AC-3: a declared package with no resolvable version fails with SYSTEM-VS-06", async () => {
    const beta = await specConsumer(null);
    const root = await systemWith(
      { beta },
      { "system/scenarios/s.yaml": scenario("s", ["beta"], ok) },
    );
    const res = await runSystemVersionSetRecord(
      { argv: [], flags: { products: `beta=${TAG}`, scenarios: "s" } },
      makeContext(root),
    );
    expect(res.exitCode).toBe(1);
    expect(res.data!.diagnostics.map((d) => d.ruleId)).toContain("SYSTEM-VS-06");
    expect(res.data!.created).toBe(false);
  });

  it("lockfileVersion reads devDependencies and ignores nested importers", () => {
    const lock = {
      importers: {
        ".": { devDependencies: { x: { version: "1.2.3(peer@1.0.0)" } } },
        "packages/a": { dependencies: { y: { version: "9.9.9" } } },
      },
    };
    expect(lockfileVersion(lock, "x")).toBe("1.2.3");
    expect(lockfileVersion(lock, "y")).toBeNull();
  });
});
