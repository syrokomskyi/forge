/*
<MODULE_CONTRACT>
<purpose>RFC-1580: contracts of `correctness.gate` — rule ids, violations,
oracle origins, the `forge/oracle-review@1` record schema, and the
`forge/correctness-bundle@1` evidence bundle.</purpose>
<non-goals>
  <item>No logic — types, schemas, constants.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial gate contracts.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

export type GateRuleId =
  | "CORR-GATE-01"
  | "CORR-GATE-02"
  | "CORR-GATE-03"
  | "CORR-GATE-04"
  | "CORR-GATE-05"
  | "CORR-GATE-06"
  | "CORR-GATE-07"
  | "CORR-GATE-08";

export const GATE_RULE_IDS: readonly GateRuleId[] = [
  "CORR-GATE-01",
  "CORR-GATE-02",
  "CORR-GATE-03",
  "CORR-GATE-04",
  "CORR-GATE-05",
  "CORR-GATE-06",
  "CORR-GATE-07",
  "CORR-GATE-08",
];

export type OracleOrigin = "verified" | "requirement" | "self";

export interface GateViolation {
  rule: GateRuleId;
  severity: "error" | "warning";
  entry?: string;
  check?: string;
  message: string;
}

export interface Weakening {
  kind: string;
  subject: string;
  message: string;
}

export const ORACLE_REVIEW_SCHEMA = "forge/oracle-review@1" as const;
export const CORRECTNESS_BUNDLE_SCHEMA = "forge/correctness-bundle@1" as const;
export const DEFAULT_ORACLE_REVIEWS_DIR = "docs/correctness/reviews";
export const DEFAULT_ORACLE_TIMEOUT_MS = 300_000;

export const oracleReviewSchema = z
  .object({
    schema: z.literal(ORACLE_REVIEW_SCHEMA),
    reviewedAt: z.string().min(1),
    isolation: z.string().min(1),
    candidate: z.string().min(1),
    export: z.string().optional(),
    verdict: z.enum(["pass", "fail"]),
    oracles: z
      .array(
        z
          .object({
            check: z.string().min(1),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            verdict: z.enum(["pass", "fail"]),
            attestedHandleIsUnderTest: z.boolean().optional(),
            notes: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export type OracleReview = z.infer<typeof oracleReviewSchema>;

export interface BundleOracle {
  check: string;
  origin: OracleOrigin;
  originDetail: string;
  declaredSubstrate: string;
  attestation: { level: string; engine: string; schemaHash: string; matches: boolean } | null;
  command: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  anchorEvents: { anchor: string; ok: boolean; reason?: string }[];
  covers: boolean;
}

export interface BundleEntry {
  id: string;
  ref: string | null;
  seam: string;
  covered: boolean;
  oracles: BundleOracle[];
}

export interface CorrectnessBundle {
  schema: typeof CORRECTNESS_BUNDLE_SCHEMA;
  repository: string;
  base: string;
  head: string;
  mode: string;
  tier: string;
  gateBuild: { forge: string; path: string };
  entries: BundleEntry[];
  weakenings: (Weakening & { accepted: boolean })[];
  violations: GateViolation[];
  limitations: string[];
}

export const BUNDLE_LIMITATIONS = [
  "git trailers are agent-writable; the verifier trailer raises the cost of mislabeling, it does not prove authorship",
  "a schema-hash attestation proves the handle reported a schema matching the migrations, not that every assertion used it",
  "imports of oracle files outside the declared support globs are not frozen, and neither are dependency patches or lockfile pins of the test-side helpers",
];

export interface CorrectnessGateResult {
  command: "correctness.gate";
  mode: "warn" | "enforce" | "exempt";
  status: "pass" | "fail" | "exempt";
  bundlePath: string;
  violations: GateViolation[];
  weakenings: (Weakening & { accepted: boolean })[];
  acceptedWeakening: string | null;
}
