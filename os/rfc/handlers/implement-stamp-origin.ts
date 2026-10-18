/*
<MODULE_CONTRACT>
<purpose>
RFC-1330: stamp-time origin gates for rfc.implement.stamp — RFC-IMP-10 blocks
a declared expectationSource that git-derived origin contradicts, RFC-IMP-11
requires non-self evidence for every WHEN/IF criterion of a
verificationTier: high RFC.
</purpose>
<non-goals>
  <item>Do not derive origins — verification-origin.ts owns derivation.</item>
  <item>Do not mutate the RFC or rewrite declarations — the RFC text must be corrected by its author.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Origins are derived fresh at stamp time (head = HEAD), never read from the committed envelope.</item>
  <item>`unresolved` never fires RFC-IMP-10 — no contradiction is proven without history.</item>
  <item>RFC-IMP-11 severity is a module constant until RFC-1333 provides non-self evidence.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1330: RFC-IMP-10 (blocking) and RFC-IMP-11 (warning until RFC-1333) origin gates.</item>
  <item>RFC-1333: steps 1-3 — report contract, rfc.verify.workspace export, RFC-IMP-12 gate, RFC-IMP-11 blocking</item>
  <item>RFC-1333: resolve acceptance counterexamples CX-1 and CX-2

Candidate binding accepts docs/** only; the operator waiver also covers a missing report; RFC-IMP-12 applies to probe-less HIGH-tier RFCs.</item>
</CHANGE_SUMMARY>
*/

import { RFC_ORIGIN_CUTOFF } from "../types.ts";
import type { AcceptanceProbe, ProbeOriginRecord, RfcImplementStampViolation } from "../types.ts";
import { listBehavioralCriteria } from "./validate-rules.ts";

/**
 * RFC-IMP-11 is blocking since RFC-1333: post-commitment independent
 * verification gives HIGH-tier RFCs a source of non-self evidence.
 */
export const RFC_IMP_11_BLOCKING = true;

const NON_SELF = new Set(["requirement", "independent", "external"]);

export interface OriginGateInput {
  targetId: string;
  frontmatter: Record<string, unknown>;
  body: string;
  probes: AcceptanceProbe[];
  origins: ProbeOriginRecord[];
  /** Overrides RFC_IMP_11_BLOCKING (tests, RFC-1333 flip). */
  imp11Blocking?: boolean;
}

export interface OriginGateResult {
  errors: RfcImplementStampViolation[];
  warnings: RfcImplementStampViolation[];
}

function describeProbe(probe: AcceptanceProbe, index: number): string {
  const target =
    probe.probe === "test" ? probe.file : probe.probe === "run" ? probe.command : probe.probe;
  return `probe ${index} (${probe.probe}${probe.criterion ? ` → ${probe.criterion}` : ""}: ${target})`;
}

/** Evaluate RFC-IMP-10 / RFC-IMP-11 for a post-cutoff RFC. Pure function. */
export function evaluateOriginGates(input: OriginGateInput): OriginGateResult {
  const errors: RfcImplementStampViolation[] = [];
  const warnings: RfcImplementStampViolation[] = [];
  if (String(input.frontmatter["createdAt"] ?? "") < RFC_ORIGIN_CUTOFF) return { errors, warnings };

  input.probes.forEach((probe, i) => {
    const origin = input.origins[i];
    if (!origin) return;
    if (origin.derivedOrigin === "self" && NON_SELF.has(String(origin.declared))) {
      errors.push({
        rule: "RFC-IMP-10",
        message:
          `${input.targetId} ${describeProbe(probe, i)} declares expectationSource "${origin.declared}" but git derives it self ` +
          `(${origin.reason.join("; ")}). Correct the declaration to "self", or obtain non-self evidence — never rewrite history.`,
      });
    }
  });

  if (input.frontmatter["verificationTier"] === "high") {
    const blocking = input.imp11Blocking ?? RFC_IMP_11_BLOCKING;
    for (const id of listBehavioralCriteria(input.body)) {
      const hasNonSelf = input.probes.some(
        (p, i) => p.criterion === id && NON_SELF.has(String(input.origins[i]?.effective)),
      );
      if (hasNonSelf) continue;
      const violation: RfcImplementStampViolation = {
        rule: "RFC-IMP-11",
        message: `${input.targetId} is verificationTier: high but ${id} (WHEN/IF) has no bound probe with a non-self effective origin. Obtain independent evidence (post-commitment verification) for ${id}.`,
      };
      (blocking ? errors : warnings).push(violation);
    }
  }
  return { errors, warnings };
}

// ─── RFC-1333: RFC-IMP-12 acceptance-verification report gate ────────────────

export const ACCEPTANCE_REPORTS_DIR = "docs/reviews/acceptance";

export interface AcceptanceGateInput {
  targetId: string;
  frontmatter: Record<string, unknown>;
  /** Report frontmatters found under docs/reviews/acceptance/<id>/ (committed). */
  reports: Array<{ path: string; frontmatter: Record<string, unknown> }>;
  /** True when every non-docs commit in candidate..HEAD carries the verifier trailers. */
  isCandidateBound: (candidateSha: string) => Promise<boolean>;
  waiverReason?: string;
}

/** Evaluate RFC-IMP-12 for a post-cutoff verificationTier: high RFC. */
export async function evaluateAcceptanceVerificationGate(
  input: AcceptanceGateInput,
): Promise<OriginGateResult> {
  const errors: RfcImplementStampViolation[] = [];
  const warnings: RfcImplementStampViolation[] = [];
  const fm = input.frontmatter;
  if (String(fm["createdAt"] ?? "") < RFC_ORIGIN_CUTOFF || fm["verificationTier"] !== "high") {
    return { errors, warnings };
  }
  const passing = input.reports.filter((r) => r.frontmatter["verdict"] === "pass");
  const bound: typeof passing = [];
  for (const r of passing) {
    const sha = String(r.frontmatter["candidateSha"] ?? "");
    if (sha && (await input.isCandidateBound(sha))) bound.push(r);
  }
  if (bound.length === 0) {
    if (input.waiverReason) {
      warnings.push({
        rule: "RFC-IMP-12",
        message: `${input.targetId} has no bound passing acceptance report. Waived by operator: ${input.waiverReason}`,
      });
      return { errors, warnings };
    }
    errors.push({
      rule: "RFC-IMP-12",
      message: `${input.targetId} is verificationTier: high but has no committed verdict: pass acceptance report in ${ACCEPTANCE_REPORTS_DIR}/${input.targetId.toLowerCase()}/ bound to the current code (only verifier-trailer or docs commits may follow the candidate). Run the independent acceptance verification step.`,
    });
    return { errors, warnings };
  }
  if (!bound.some((r) => r.frontmatter["isolation"] === "subagent")) {
    const v: RfcImplementStampViolation = {
      rule: "RFC-IMP-12",
      message: `${input.targetId} acceptance report ${bound[0]!.path} records isolation "${String(bound[0]!.frontmatter["isolation"])}", not subagent.`,
    };
    if (input.waiverReason) {
      warnings.push({ ...v, message: `${v.message} Waived by operator: ${input.waiverReason}` });
    } else {
      errors.push({
        ...v,
        message: `${v.message} Re-run with a clean-context subagent, or the operator may waive with --waive-independent-verification "<reason>".`,
      });
    }
  }
  return { errors, warnings };
}
