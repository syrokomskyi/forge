/*
<MODULE_CONTRACT>
<purpose>Zod schemas and TypeScript types for the forge spec vendoring contract (RFC-0394).</purpose>
<non-goals>
  <item>Do not implement validation logic — that lives in spec-validate.ts.</item>
  <item>Do not implement materialization or status logic — that is RFC-0396.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0394: initial spec schema — forge/spec@1, integrity manifest, decision/rfc/wave types.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

// ---------------------------------------------------------------------------
// Spec decision
// ---------------------------------------------------------------------------

export const specDecisionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["accepted", "amended", "rejected"]),
  rationale: z.string().min(1),
  promotedTo: z.string().optional(),
});

export interface SpecDecision extends z.infer<typeof specDecisionSchema> {}

// ---------------------------------------------------------------------------
// Spec RFC node
// ---------------------------------------------------------------------------

export const specRfcNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  wave: z.number().int().min(1),
  sources: z.array(z.string()).default([]),
  materializedAs: z.string().optional(),
});

export interface SpecRfcNode extends z.infer<typeof specRfcNodeSchema> {}

// ---------------------------------------------------------------------------
// Spec wave
// ---------------------------------------------------------------------------

export const specWaveSchema = z.object({
  id: z.number().int().min(1),
  name: z.string().min(1),
  goal: z.string().min(1),
});

export interface SpecWave extends z.infer<typeof specWaveSchema> {}

// ---------------------------------------------------------------------------
// Forge spec (forge/spec@1)
// ---------------------------------------------------------------------------

export const forgeSpecSchema = z.object({
  schema: z.literal("forge/spec@1"),
  id: z.string().min(1),
  title: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(["vendored", "accepted", "superseded"]),
  reviewers: z.array(z.string()).default([]),
  sourceNote: z.string().min(1),
  vendoredAt: z.string().min(1),
  documents: z.record(z.string(), z.string()).default({}),
  decisions: z.array(specDecisionSchema).default([]),
  rfcs: z.array(specRfcNodeSchema).default([]),
  waves: z.array(specWaveSchema).default([]),
  /** Set when this spec supersedes an older version (RFC-0397). */
  supersedes: z.string().optional(),
});

export interface ForgeSpec extends z.infer<typeof forgeSpecSchema> {}

// ---------------------------------------------------------------------------
// Integrity manifest (forge/spec-integrity@1)
// ---------------------------------------------------------------------------

export const specIntegritySchema = z.object({
  schema: z.literal("forge/spec-integrity@1"),
  files: z.record(z.string(), z.string()).default({}),
});

export interface SpecIntegrity extends z.infer<typeof specIntegritySchema> {}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export interface SpecViolation {
  rule: string;
  message: string;
}

export interface SpecValidateResult {
  command: "spec.validate";
  status: "pass" | "fail";
  specs: Array<{
    id: string;
    status: string;
    violations: SpecViolation[];
  }>;
}

// ---------------------------------------------------------------------------
// Spec amendment (RFC-0397)
// ---------------------------------------------------------------------------

export const specAmendmentTargetSchema = z.union([
  z.object({
    kind: z.literal("section"),
    document: z.string().min(1),
    anchor: z.string().min(1),
  }),
  z.object({
    kind: z.literal("decision"),
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("node"),
    id: z.string().min(1),
  }),
]);

export type SpecAmendmentTarget = z.infer<typeof specAmendmentTargetSchema>;

export const specAmendmentSchema = z.object({
  schema: z.literal("forge/spec-amendment@1"),
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["proposed", "accepted", "rejected"]),
  createdAt: z.string().min(1),
  reviewers: z.array(z.string()).default([]),
  targets: z.array(specAmendmentTargetSchema).min(1),
  discoveredBy: z.string().min(1),
});

export interface SpecAmendment extends z.infer<typeof specAmendmentSchema> {}

// ---------------------------------------------------------------------------
// resolveAmendedNode — apply accepted amendments to a roadmap node
// ---------------------------------------------------------------------------

export function resolveAmendedNode(
  spec: ForgeSpec,
  nodeId: string,
  amendments: SpecAmendment[],
): SpecRfcNode {
  const node = spec.rfcs.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  const acceptedAmendments = amendments.filter(
    (a) => a.status === "accepted" && a.targets.some((t) => t.kind === "node" && t.id === nodeId),
  );

  if (acceptedAmendments.length === 0) return node;

  // Apply amendments — later amendments override earlier ones
  let resolved = { ...node };
  for (const amendment of acceptedAmendments) {
    // Amendments compose at read time; the node's title gets an annotation
    resolved = {
      ...resolved,
      title: `${resolved.title} (as amended by ${amendment.id})`,
    };
  }

  return resolved;
}
