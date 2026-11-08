/*
<MODULE_CONTRACT>
<purpose>RFC-1541 AC-4..AC-6, AC-14 — the validator check kind over the shared conformance path, and its SYSTEM-MAP-07 lint.</purpose>
<non-goals><item>Conformance leg semantics are owned by RFC-1365/1539 tests.</item></non-goals>
</MODULE_CONTRACT>
*/
// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { runSystemVersionSetRecord } from "../handlers/system-versionset-record.ts";
import { runSystemMapValidate } from "../handlers/system-map-validate.ts";
import { makeContext } from "./helpers.ts";
import {
  TAG,
  VALIDATOR_PKG,
  scenario,
  systemWith,
  validatorProducer,
} from "./contract-fixtures.ts";

const validatorCheck = (producer = "intake") =>
  `  - kind: validator\n    product: alpha\n    producer: ${producer}\n`;

async function record(root: string) {
  return runSystemVersionSetRecord(
    { argv: [], flags: { products: `alpha=${TAG}`, scenarios: "v" } },
    makeContext(root),
  );
}

describe("validator check kind (RFC-1541)", () => {
  it("AC-4: passes for a consumer.package producer whose conformance run passes", async () => {
    const alpha = await validatorProducer("package");
    const root = await systemWith(
      { alpha },
      { "system/scenarios/v.yaml": scenario("v", ["alpha"], validatorCheck()) },
    );
    const res = await record(root);
    expect(res.data!.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res.data!.created).toBe(true);
  });

  it("AC-5: the evidence names the validator package and version", async () => {
    const alpha = await validatorProducer("package");
    const root = await systemWith(
      { alpha },
      { "system/scenarios/v.yaml": scenario("v", ["alpha"], validatorCheck()) },
    );
    await record(root);
    const log = await readFile(
      path.join(root, "system/version-sets/evidence/VS-0001/v.log"),
      "utf8",
    );
    expect(log).toContain(`validator: ${VALIDATOR_PKG}@2.1.0`);
    const set = YAML.parse(
      await readFile(path.join(root, "system/version-sets/VS-0001.yaml"), "utf8"),
    );
    expect(set.contracts.alpha[VALIDATOR_PKG]).toBe("2.1.0");
  });

  it("AC-6: a consumer.root producer fails with SYSTEM-VS-07", async () => {
    const alpha = await validatorProducer("root");
    const root = await systemWith(
      { alpha },
      { "system/scenarios/v.yaml": scenario("v", ["alpha"], validatorCheck()) },
    );
    const res = await record(root);
    expect(res.exitCode).toBe(1);
    expect(res.data!.diagnostics.map((d) => d.ruleId)).toContain("SYSTEM-VS-07");
  });

  it("a failing validator fails the record", async () => {
    const alpha = await validatorProducer("package", 3);
    const root = await systemWith(
      { alpha },
      { "system/scenarios/v.yaml": scenario("v", ["alpha"], validatorCheck()) },
    );
    const res = await record(root);
    expect(res.exitCode).toBe(1);
    expect(res.data!.created).toBe(false);
  });

  it("AC-14: map.validate rejects a validator check naming an unknown producer", async () => {
    const alpha = await validatorProducer("package");
    const root = await systemWith(
      { alpha },
      { "system/scenarios/v.yaml": scenario("v", ["alpha"], validatorCheck("nope")) },
    );
    const res = await runSystemMapValidate({ argv: [], flags: {} }, makeContext(root));
    expect(res.data!.diagnostics).toContainEqual(
      expect.objectContaining({ ruleId: "SYSTEM-MAP-07", severity: "error" }),
    );
  });
});
