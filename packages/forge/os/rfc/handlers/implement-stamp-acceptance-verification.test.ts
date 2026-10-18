/*
<MODULE_CONTRACT>
<purpose>RFC-1333: RFC-IMP-12 tests — HIGH-tier stamps need a committed passing, subagent-isolated acceptance report bound to the current code.</purpose>
<non-goals>
  <item>Do not read git — reports and candidate binding are supplied directly.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1333: tests for AC-5 and AC-6.</item>
  <item>RFC-1333: steps 1-3 — report contract, rfc.verify.workspace export, RFC-IMP-12 gate, RFC-IMP-11 blocking</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";
import { evaluateAcceptanceVerificationGate } from "./implement-stamp-origin.ts";

const fm = { createdAt: "2026-10-18", verificationTier: "high" };
const report = (extra: Record<string, unknown>) => ({
  path: "docs/reviews/acceptance/rfc-9001/acceptance-2026-10-18-r0.md",
  frontmatter: {
    rfcId: "RFC-9001",
    candidateSha: "abc1234",
    round: 0,
    verdict: "pass",
    isolation: "subagent",
    ...extra,
  },
});

describe("RFC-IMP-12 (RFC-1333)", () => {
  it("blocks RFC-IMP-12 when a high-tier RFC has no pass report bound to the implementation commit", async () => {
    const none = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9001",
      frontmatter: fm,
      reports: [],
      isCandidateBound: async () => true,
    });
    expect(none.errors.map((e) => e.rule)).toEqual(["RFC-IMP-12"]);
    const unbound = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9001",
      frontmatter: fm,
      reports: [report({})],
      isCandidateBound: async () => false,
    });
    expect(unbound.errors.map((e) => e.rule)).toEqual(["RFC-IMP-12"]);
    const ok = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9001",
      frontmatter: fm,
      reports: [report({})],
      isCandidateBound: async () => true,
    });
    expect(ok.errors).toEqual([]);
  });

  it("blocks RFC-IMP-12 when the bound report records non-subagent isolation without a waiver", async () => {
    const input = {
      targetId: "RFC-9001",
      frontmatter: fm,
      reports: [report({ isolation: "isolated-inline" })],
      isCandidateBound: async () => true,
    };
    const blocked = await evaluateAcceptanceVerificationGate(input);
    expect(blocked.errors.map((e) => e.rule)).toEqual(["RFC-IMP-12"]);
    const waived = await evaluateAcceptanceVerificationGate({
      ...input,
      waiverReason: "operator: no subagent on this platform",
    });
    expect(waived.errors).toEqual([]);
    expect(waived.warnings[0]?.message).toContain("Waived by operator");
  });

  it("ignores standard-tier and pre-cutoff RFCs", async () => {
    const std = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9001",
      frontmatter: { createdAt: "2026-10-18" },
      reports: [],
      isCandidateBound: async () => true,
    });
    expect(std.errors).toEqual([]);
  });
});
