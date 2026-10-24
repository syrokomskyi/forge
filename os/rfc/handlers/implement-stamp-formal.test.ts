/*
<MODULE_CONTRACT>
<purpose>
RFC-1391: formal-tier stamp gates — RFC-IMP-13 blocks a formal RFC whose proof
probes lack a `proved` envelope verdict (no waiver), and RFC-IMP-11/RFC-IMP-12
apply to `verificationTier: formal` exactly as to `high` (AC-5, AC-6).
</purpose>
<non-goals>
  <item>Do not exercise git — origins, reports, and envelope records are supplied directly.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391: IMP-13 formal gate + formal-tier IMP-11/12 applicability tests.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";
import {
  evaluateAcceptanceVerificationGate,
  evaluateFormalProofGate,
  evaluateOriginGates,
} from "./implement-stamp-origin.ts";
import type {
  AcceptanceProbe,
  ProbeOriginRecord,
  VerificationEvidenceProbeRecord,
} from "../types.ts";

const BODY = `
## Acceptance criteria

- [ ] AC-1: WHEN the gate sees a weakened test, THE commit SHALL be blocked.
- [ ] AC-2: THE module SHALL export the evaluator.

## Implementation notes for agents
`;

const proofProbe: AcceptanceProbe = {
  probe: "proof",
  criterion: "AC-1",
  spec: "docs/specs/proofs/x.proof.yaml",
};

const formalFm = (extra: Record<string, unknown> = {}) => ({
  createdAt: "2026-10-18",
  verificationTier: "formal",
  ...extra,
});

const record = (
  probe: AcceptanceProbe,
  verdict: "proved" | "refuted" | "unavailable" | "error" | undefined,
): VerificationEvidenceProbeRecord => ({
  probe,
  ok: verdict === "proved",
  detail: "",
  durationMs: 1,
  ...(verdict
    ? { proof: { tool: "t", toolVersion: "1", verdict, specSha256: "s", entrySha256: "e" } }
    : {}),
});

describe("RFC-IMP-13 (RFC-1391)", () => {
  it("blocks RFC-IMP-13 for a formal-tier RFC without a proved proof probe", () => {
    // No proof probe at all → blocked.
    const noProbe = evaluateFormalProofGate({
      targetId: "RFC-9001",
      frontmatter: formalFm(),
      probes: [
        { probe: "test", criterion: "AC-1", file: "x.test.ts", expect: { exitCode: 0 } },
      ],
      evidenceRecords: [],
    });
    expect(noProbe.errors.map((e) => e.rule)).toEqual(["RFC-IMP-13"]);
    expect(noProbe.errors[0]!.message).toContain("no proof probe");

    // Proof probe present but envelope verdict is not proved → blocked per verdict.
    for (const verdict of ["refuted", "unavailable", "error"] as const) {
      const res = evaluateFormalProofGate({
        targetId: "RFC-9001",
        frontmatter: formalFm(),
        probes: [proofProbe],
        evidenceRecords: [record(proofProbe, verdict)],
      });
      expect(res.errors.map((e) => e.rule)).toEqual(["RFC-IMP-13"]);
      expect(res.errors[0]!.message).toContain(`"${verdict}"`);
    }

    // Missing envelope record entirely → blocked.
    const missing = evaluateFormalProofGate({
      targetId: "RFC-9001",
      frontmatter: formalFm(),
      probes: [proofProbe],
      evidenceRecords: [],
    });
    expect(missing.errors.map((e) => e.rule)).toEqual(["RFC-IMP-13"]);
    expect(missing.errors[0]!.message).toContain('"missing"');

    // Proved → gate passes.
    const ok = evaluateFormalProofGate({
      targetId: "RFC-9001",
      frontmatter: formalFm(),
      probes: [proofProbe],
      evidenceRecords: [record(proofProbe, "proved")],
    });
    expect(ok.errors).toEqual([]);
  });

  it("does not fire for non-formal tiers", () => {
    for (const tier of ["high", "standard"]) {
      const res = evaluateFormalProofGate({
        targetId: "RFC-9001",
        frontmatter: formalFm({ verificationTier: tier }),
        probes: [],
        evidenceRecords: [],
      });
      expect(res.errors).toEqual([]);
    }
  });
});

describe("formal tier inherits the strict gates (RFC-1391)", () => {
  it("applies RFC-IMP-11 and RFC-IMP-12 to formal-tier RFCs", async () => {
    // IMP-11: formal WHEN/IF criterion with only self-origin evidence → blocked.
    const selfOrigin: ProbeOriginRecord = {
      declared: "self",
      derivedOrigin: "self",
      effective: "self",
      reason: ["abc1234 touched x.test.ts"],
    };
    const imp11 = evaluateOriginGates({
      targetId: "RFC-9001",
      frontmatter: formalFm(),
      body: BODY,
      probes: [
        { probe: "test", criterion: "AC-1", file: "x.test.ts", expect: { exitCode: 0 } },
      ],
      origins: [selfOrigin],
    });
    expect(imp11.errors.map((e) => e.rule)).toEqual(["RFC-IMP-11"]);
    expect(imp11.errors[0]!.message).toContain("formal");

    // IMP-12: formal RFC with no bound pass report → blocked.
    const imp12 = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9001",
      frontmatter: formalFm(),
      reports: [],
      isCandidateBound: async () => true,
    });
    expect(imp12.errors.map((e) => e.rule)).toEqual(["RFC-IMP-12"]);
    expect(imp12.errors[0]!.message).toContain("formal");

    // And a bound passing report clears IMP-12 for formal too.
    const cleared = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9001",
      frontmatter: formalFm(),
      reports: [
        {
          path: "docs/reviews/acceptance/rfc-9001/acceptance-2026-10-18-r0.md",
          frontmatter: { verdict: "pass", candidateSha: "abc1234", isolation: "subagent" },
        },
      ],
      isCandidateBound: async () => true,
    });
    expect(cleared.errors).toEqual([]);
  });
});
