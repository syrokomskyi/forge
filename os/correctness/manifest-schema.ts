/*
<MODULE_CONTRACT>
<purpose>RFC-1578: contracts of the product correctness manifest
(`forge/correctness-manifest@1`) and its capture sidecar
(`forge/correctness-capture@1`) — zod schemas, TypeScript types, the
substrate ladder, and the seam-type substrate minimums.</purpose>
<non-goals>
  <item>Do not resolve references or read files — handlers/validate.ts owns evaluation.</item>
  <item>Do not freeze or attest anything — RFC-1580 consumes these contracts.</item>
  <item>Do not import from @warpgogol/* — forge autonomy.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Entry ids use the CM- prefix so they are never misread as CORR- rule ids.</item>
  <item>The seam minimum is fixed by seam type, never by tier (grilling Q5).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial manifest + capture schemas, ladder, seam minimums.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

export const CORRECTNESS_MANIFEST_SCHEMA = "forge/correctness-manifest@1" as const;
export const CORRECTNESS_CAPTURE_SCHEMA = "forge/correctness-capture@1" as const;
export const CAPTURE_SIDECAR_SUFFIX = ".capture.yaml";
export const DEFAULT_CORRECTNESS_MANIFEST_PATH = "docs/correctness.yaml";

export const MANIFEST_SOURCES = ["req", "dna", "rfc-ac", "fixed-input", "domain"] as const;
export const SEAMS = ["data", "lifecycle", "provider", "other"] as const;
export const SUBSTRATES = ["L0", "L1", "L2", "L3"] as const;
export const CORRECTNESS_MODES = ["warn", "enforce", "exempt"] as const;
export const CORRECTNESS_TIERS = ["standard", "high", "formal"] as const;

export type ManifestSource = (typeof MANIFEST_SOURCES)[number];
export type Seam = (typeof SEAMS)[number];
export type Substrate = (typeof SUBSTRATES)[number];
export type CorrectnessMode = (typeof CORRECTNESS_MODES)[number];
export type CorrectnessTier = (typeof CORRECTNESS_TIERS)[number];

/** Ladder names, in order (RFC-1578 FI-2). */
export const SUBSTRATE_NAMES: Record<Substrate, string> = {
  L0: "double",
  L1: "engine",
  L2: "runtime",
  L3: "live",
};

/** Seam-type minimums (RFC-1578 FI-3). `provider` additionally accepts L1/L2 with a fresh capture. */
export const SEAM_MINIMUM: Record<Seam, Substrate> = {
  data: "L1",
  lifecycle: "L2",
  provider: "L3",
  other: "L0",
};

export function substrateRank(level: Substrate): number {
  return SUBSTRATES.indexOf(level);
}

export const CORRECTNESS_ENTRY_ID_RE = /^CM-[a-z0-9]+(-[a-z0-9]+)*-\d{2,3}$/;

export const correctnessOracleSchema = z
  .object({
    check: z.string().min(1),
    substrate: z.enum(SUBSTRATES),
    captures: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const correctnessEntrySchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(MANIFEST_SOURCES),
    ref: z.string().min(1).optional(),
    statement: z.string().min(1).optional(),
    seam: z.enum(SEAMS),
    anchors: z.array(z.string().min(1)).min(1),
    oracles: z.array(correctnessOracleSchema).min(1),
  })
  .strict();

export const correctnessExemptionSchema = z
  .object({
    ref: z.string().min(1),
    kind: z.enum(["unverifiable", "deferred"]),
    reason: z.string().optional(),
    task: z.string().optional(),
  })
  .strict();

export const correctnessManifestSchema = z
  .object({
    schema: z.literal(CORRECTNESS_MANIFEST_SCHEMA),
    entries: z.array(correctnessEntrySchema).default([]),
    support: z.array(z.string().min(1)).default([]),
    exemptions: z.array(correctnessExemptionSchema).default([]),
  })
  .strict();

export const correctnessCaptureSchema = z
  .object({
    schema: z.literal(CORRECTNESS_CAPTURE_SCHEMA),
    recordedAt: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    ttlDays: z.number().positive(),
    origin: z.string().min(1),
  })
  .passthrough();

export type CorrectnessOracle = z.infer<typeof correctnessOracleSchema>;
export type CorrectnessEntry = z.infer<typeof correctnessEntrySchema>;
export type CorrectnessExemption = z.infer<typeof correctnessExemptionSchema>;
export type CorrectnessManifest = z.infer<typeof correctnessManifestSchema>;
export type CorrectnessCapture = z.infer<typeof correctnessCaptureSchema>;

export interface CorrectnessConfig {
  mode: CorrectnessMode;
  tier: CorrectnessTier;
}

export type CorrectnessRuleId =
  | "CORR-01"
  | "CORR-02"
  | "CORR-03"
  | "CORR-04"
  | "CORR-05"
  | "CORR-06"
  | "CORR-07"
  | "CORR-08"
  | "CORR-09";

export const CORRECTNESS_RULE_IDS: readonly CorrectnessRuleId[] = [
  "CORR-01",
  "CORR-02",
  "CORR-03",
  "CORR-04",
  "CORR-05",
  "CORR-06",
  "CORR-07",
  "CORR-08",
  "CORR-09",
];

export interface CorrectnessViolation {
  rule: CorrectnessRuleId;
  severity: "error" | "warning";
  message: string;
  entry?: string;
  ref?: string;
}

export interface CoverageCounts {
  total: number;
  anchored: number;
  exempt: number;
  silent: number;
}

export interface CorrectnessValidateResult {
  command: "correctness.manifest.validate";
  mode: CorrectnessMode;
  tier: CorrectnessTier;
  status: "pass" | "fail" | "exempt";
  manifest: string | null;
  coverage: { req: CoverageCounts; dna: CoverageCounts };
  violations: CorrectnessViolation[];
}
