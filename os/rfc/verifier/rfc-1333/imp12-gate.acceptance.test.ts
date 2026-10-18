// RFC-1333 AC-5, AC-6 — RFC-IMP-12 gate (pure evaluator).
import { describe, expect, it } from "vitest";
import { evaluateAcceptanceVerificationGate } from "../../handlers/implement-stamp-origin.ts";

const fm = { createdAt: "2026-10-18", verificationTier: "high" };
const rep = (f: Record<string, unknown>) => ({
  path: "docs/reviews/acceptance/rfc-9/a-r0.md",
  frontmatter: f,
});
const bound = async () => true;

describe("RFC-IMP-12", () => {
  it("AC-5: no report blocks", async () => {
    const r = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9",
      frontmatter: fm,
      reports: [],
      isCandidateBound: bound,
    });
    expect(r.errors.map((e) => e.rule)).toContain("RFC-IMP-12");
  });
  it("AC-5: non-pass verdict blocks", async () => {
    const r = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9",
      frontmatter: fm,
      reports: [rep({ verdict: "counterexamples", isolation: "subagent", candidateSha: "abc" })],
      isCandidateBound: bound,
    });
    expect(r.errors.map((e) => e.rule)).toContain("RFC-IMP-12");
  });
  it("AC-5: unbound candidate blocks", async () => {
    const r = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9",
      frontmatter: fm,
      reports: [rep({ verdict: "pass", isolation: "subagent", candidateSha: "abc" })],
      isCandidateBound: async () => false,
    });
    expect(r.errors.map((e) => e.rule)).toContain("RFC-IMP-12");
  });
  it("AC-5: bound pass subagent report passes", async () => {
    const r = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9",
      frontmatter: fm,
      reports: [rep({ verdict: "pass", isolation: "subagent", candidateSha: "abc" })],
      isCandidateBound: bound,
    });
    expect(r.errors).toEqual([]);
  });
  it("AC-6: non-subagent isolation without waiver blocks; with waiver warns", async () => {
    const reports = [rep({ verdict: "pass", isolation: "inline", candidateSha: "abc" })];
    const a = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9",
      frontmatter: fm,
      reports,
      isCandidateBound: bound,
    });
    expect(a.errors.map((e) => e.rule)).toContain("RFC-IMP-12");
    const b = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9",
      frontmatter: fm,
      reports,
      isCandidateBound: bound,
      waiverReason: "no subagents",
    });
    expect(b.errors).toEqual([]);
    expect(b.warnings.map((e) => e.rule)).toContain("RFC-IMP-12");
  });
});

describe("RFC-IMP-12 failure mode: no report", () => {
  it("design: worktree cannot be created → no report; operator may waive", async () => {
    const r = await evaluateAcceptanceVerificationGate({
      targetId: "RFC-9",
      frontmatter: fm,
      reports: [],
      isCandidateBound: bound,
      waiverReason: "export failed",
    });
    expect(r.errors).toEqual([]);
  });
});
