/*
<MODULE_CONTRACT>
<purpose>
RFC-1391: unit surface for forge/proof-spec@1 — strict schema validation
including the empty-assumptions failure (AC-7's V-46 trigger) and the required
unverified-boundaries clause.
</purpose>
<non-goals>
  <item>Do not cover V-46 emission — validate-rules tests own the RFC-level diagnostic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391: proof-spec schema validation tests.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";
import { PROOF_SPEC_SCHEMA_ID, proofSpecSchema } from "./proof-spec.ts";

const validSpec = {
  schema: PROOF_SPEC_SCHEMA_ID,
  id: "convergence-order",
  invariantRefs: ["INV-order-01"],
  statement: "commutative reduce converges for all input orderings",
  tool: "exhaustive",
  toolVersion: "1",
  entry: "packages/forge/src/formal/__fixtures__/converge.proof.test.ts",
  target: "reduce convergence",
  domain: { description: "120 orderings", cardinality: 120 },
  assumptions: ["domains are finite", "check is deterministic"],
  trustedBase: ["the forge exhaustive runner"],
  unverifiedBoundaries: ["does not cover inputs outside the declared domain"],
};

describe("proofSpecSchema (RFC-1391)", () => {
  it("accepts a well-formed spec", () => {
    const parsed = proofSpecSchema.safeParse(validSpec);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.id).toBe("convergence-order");
  });

  it("rejects an empty assumptions list — 'no assumptions' must be written explicitly", () => {
    const parsed = proofSpecSchema.safeParse({ ...validSpec, assumptions: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing or empty unverifiedBoundaries — no whole-system claims", () => {
    expect(proofSpecSchema.safeParse({ ...validSpec, unverifiedBoundaries: [] }).success).toBe(
      false,
    );
    const { unverifiedBoundaries: _omitted, ...without } = validSpec;
    expect(proofSpecSchema.safeParse(without).success).toBe(false);
  });

  it("rejects unknown keys (strict evidence shape)", () => {
    expect(proofSpecSchema.safeParse({ ...validSpec, extra: true }).success).toBe(false);
  });

  it("rejects wrong schema id and a non-token spec id", () => {
    expect(proofSpecSchema.safeParse({ ...validSpec, schema: "forge/proof-spec@2" }).success).toBe(
      false,
    );
    expect(proofSpecSchema.safeParse({ ...validSpec, id: "Not A Token" }).success).toBe(false);
  });

  it("rejects a tool outside the closed ProofTool enum", () => {
    expect(proofSpecSchema.safeParse({ ...validSpec, tool: "fast-check" }).success).toBe(false);
  });
});
