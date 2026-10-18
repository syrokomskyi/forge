/*
<MODULE_CONTRACT>
<purpose>RFC-1330: implement-stamp-origin tests — RFC-IMP-10 blocks contradicted expectationSource declarations; RFC-IMP-11 reports HIGH-tier WHEN/IF criteria without non-self evidence.</purpose>
<non-goals>
  <item>Do not exercise git — origins are supplied directly; derivation is covered by verification-origin.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1330: RFC-IMP-10/11 gate tests.</item>
  <item>RFC-1333: steps 1-3 — report contract, rfc.verify.workspace export, RFC-IMP-12 gate, RFC-IMP-11 blocking</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";
import { evaluateOriginGates, RFC_IMP_11_BLOCKING } from "./implement-stamp-origin.ts";
import type { AcceptanceProbe, ProbeOriginRecord } from "../types.ts";

const BODY = `
## Acceptance criteria

- [ ] AC-1: WHEN the gate sees a weakened test, THE commit SHALL be blocked.
- [ ] AC-2: THE module SHALL export the evaluator.

## Implementation notes for agents
`;

const probe: AcceptanceProbe = {
  probe: "test",
  criterion: "AC-1",
  file: "src/gate.test.ts",
  expect: { exitCode: 0 },
  expectationSource: "requirement",
};

const selfOrigin: ProbeOriginRecord = {
  declared: "requirement",
  derivedOrigin: "self",
  effective: "self",
  reason: ["abc1234 touched src/gate.test.ts"],
};

const fm = (extra: Record<string, unknown> = {}) => ({ createdAt: "2026-10-18", ...extra });

describe("evaluateOriginGates (RFC-1330)", () => {
  it("blocks RFC-IMP-10 when a declared non-self origin is derived self", () => {
    const result = evaluateOriginGates({
      targetId: "RFC-9001",
      frontmatter: fm(),
      body: BODY,
      probes: [probe],
      origins: [selfOrigin],
    });
    expect(result.errors.map((e) => e.rule)).toEqual(["RFC-IMP-10"]);
    expect(result.errors[0]?.message).toContain("abc1234");
  });

  it("does not fire RFC-IMP-10 for an honest self declaration or an unresolved range", () => {
    const honest = evaluateOriginGates({
      targetId: "RFC-9001",
      frontmatter: fm(),
      body: BODY,
      probes: [{ ...probe, expectationSource: "self" }],
      origins: [{ ...selfOrigin, declared: "self" }],
    });
    const unresolved = evaluateOriginGates({
      targetId: "RFC-9001",
      frontmatter: fm(),
      body: BODY,
      probes: [probe],
      origins: [{ ...selfOrigin, derivedOrigin: "unresolved" }],
    });
    expect(honest.errors).toEqual([]);
    expect(unresolved.errors).toEqual([]);
  });

  it("blocks RFC-IMP-11 when a high-tier behavioral criterion has no non-self probe", () => {
    const result = evaluateOriginGates({
      targetId: "RFC-9001",
      frontmatter: fm({ verificationTier: "high" }),
      body: BODY,
      probes: [{ ...probe, expectationSource: "self" }],
      origins: [{ ...selfOrigin, declared: "self" }],
      imp11Blocking: true,
    });
    expect(result.errors.map((e) => e.rule)).toEqual(["RFC-IMP-11"]);
    expect(result.errors[0]?.message).toContain("AC-1");
  });

  it("treats RFC-IMP-11 as blocking", () => {
    expect(RFC_IMP_11_BLOCKING).toBe(true);
    const result = evaluateOriginGates({
      targetId: "RFC-9001",
      frontmatter: fm({ verificationTier: "high" }),
      body: BODY,
      probes: [{ ...probe, expectationSource: "self" }],
      origins: [{ ...selfOrigin, declared: "self" }],
    });
    expect(result.errors.map((e) => e.rule)).toEqual(["RFC-IMP-11"]);
  });

  it("accepts a high-tier criterion backed by verifier evidence", () => {
    const result = evaluateOriginGates({
      targetId: "RFC-9001",
      frontmatter: fm({ verificationTier: "high" }),
      body: BODY,
      probes: [probe],
      origins: [
        {
          declared: "independent",
          derivedOrigin: "verifier",
          effective: "independent",
          reason: [],
        },
      ],
      imp11Blocking: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("skips RFCs created before the cutoff", () => {
    const result = evaluateOriginGates({
      targetId: "RFC-9001",
      frontmatter: { createdAt: "2026-10-01", verificationTier: "high" },
      body: BODY,
      probes: [probe],
      origins: [selfOrigin],
      imp11Blocking: true,
    });
    expect(result.errors).toEqual([]);
  });
});
