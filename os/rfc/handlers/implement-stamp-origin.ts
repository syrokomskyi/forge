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
  <item>RFC-1330: initial implementation — RFC-IMP-10 (blocking) and RFC-IMP-11 (warning).</item>
  <item>RFC-1330</item>
</CHANGE_SUMMARY>
*/

import { RFC_ORIGIN_CUTOFF } from "../types.ts";
import type { AcceptanceProbe, ProbeOriginRecord, RfcImplementStampViolation } from "../types.ts";
import { extractAcceptanceCriteriaSection, stripFencedCodeBlocks } from "./validate-rules.ts";

/**
 * RFC-IMP-11 is a warning until RFC-1333 lands: without independent
 * post-commitment verification a HIGH-tier RFC has no way to obtain non-self
 * evidence for new behavior.
 */
export const RFC_IMP_11_BLOCKING = false;

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

function behavioralCriteria(body: string): string[] {
  const section = extractAcceptanceCriteriaSection(stripFencedCodeBlocks(body));
  if (!section) return [];
  const ids: string[] = [];
  for (const line of section.split("\n")) {
    const match = /^\s*- \[[ x]\]\s*(AC-\d+):\s*(.*)$/.exec(line);
    if (match && /^(WHEN|IF)\b/.test((match[2] ?? "").trim())) ids.push(match[1]!);
  }
  return ids;
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
    for (const id of behavioralCriteria(input.body)) {
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
