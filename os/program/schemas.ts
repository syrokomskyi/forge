/*
<MODULE_CONTRACT>
<purpose>Zod schemas for the forge/program@1 control plane — program manifest,
packet, lease, completion, and recovery records. All schemas are strict and
reject unknown fields (RFC-0856).</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — forge must remain dependency-free.</item>
  <item>Do not add command logic here — schemas only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial program control-plane schemas.</item>
  <item>RFC-0857: phase-aware lease schema (preparation | execution) and preparation report schema.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const programActorSchema = z
  .string()
  .regex(/^(human|agent):.+$/, "Must be 'human:<id>' or 'agent:<id>'");

export const programStateSchema = z.enum(["preparing", "executing", "blocked", "complete"]);

export const packetStateSchema = z.enum(["draft", "sealed", "active", "completed", "blocked"]);

export const recoveryStatusSchema = z.enum(["verified", "not-applicable"]);

export const programLeasePhaseSchema = z.enum(["preparation", "execution"]);

// ---------------------------------------------------------------------------
// Program manifest: forge/program@1
// ---------------------------------------------------------------------------

export const programPacketIndexEntrySchema = z.object({
  order: z.number().int().min(0),
  packetId: z.string().min(1),
  file: z.string().min(1),
  state: packetStateSchema,
  governingDecision: z.string().min(1),
  decisionKind: z.enum(["rfc", "spec-amendment", "spec-node"]),
  resolvedRfc: z.string().nullable(),
  dependsOnPacket: z.string().nullable(),
  baseCommit: z.string().nullable(),
  sealCommit: z.string().nullable(),
  completion: z.string().nullable(),
});

export const programManifestSchema = z
  .object({
    schema: z.literal("forge/program@1"),
    program: z.string().min(1),
    title: z.string().min(1),
    branch: z.string().min(1),
    state: programStateSchema,
    currentPacket: z.string().min(1),
    steward: programActorSchema,
    sequential: z.literal(true),
    parallelism: z.literal(1),
    packets: z.array(programPacketIndexEntrySchema).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Program packet: forge/program-packet@1
// ---------------------------------------------------------------------------

export const normativeSourceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "Must be a SHA-256 hex digest"),
});

export const requiredValidationSchema = z.object({
  command: z.string().min(1),
  expectedStatus: z.literal("pass"),
  expectedDiagnostics: z.array(z.string()),
});

export const programPacketSchema = z
  .object({
    schema: z.literal("forge/program-packet@1"),
    program: z.string().min(1),
    packetId: z.string().min(1),
    state: z.enum(["draft", "sealed"]),
    governingDecision: z.string().min(1),
    decisionKind: z.enum(["rfc", "spec-amendment", "spec-node"]),
    resolvedRfc: z.string().nullable(),
    dependsOnPacket: z.string().nullable(),
    baseCommit: z.string().nullable(),
    branch: z.string().min(1),
    steward: programActorSchema,
    normativeSources: z.array(normativeSourceSchema),
    allowedFiles: z.array(z.string().min(1)).min(1),
    forbiddenFiles: z.array(z.string().min(1)),
    permittedTransitionDiagnostics: z.array(z.string()),
    requiredValidations: z.array(requiredValidationSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Program packet lease: forge/program-packet-lease@1
// ---------------------------------------------------------------------------

export const programPacketLeaseSchema = z
  .object({
    schema: z.literal("forge/program-packet-lease@1"),
    program: z.string().min(1),
    packetId: z.string().min(1),
    phase: programLeasePhaseSchema,
    actor: programActorSchema,
    baseCommit: z.string().min(1),
    sealCommit: z.string().nullable(),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/, "Must be a SHA-256 hex digest"),
    startedAt: z.string().min(1),
    heartbeatAt: z.string().min(1),
    timeoutSeconds: z.number().int().positive(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Program packet preparation: forge/program-packet-preparation@1 (RFC-0857)
// ---------------------------------------------------------------------------

export const preparationValidationSchema = z.object({
  command: z.string().min(1),
  status: z.literal("pass"),
  evidenceDigest: z.string().min(1),
});

export const programPacketPreparationSchema = z
  .object({
    schema: z.literal("forge/program-packet-preparation@1"),
    program: z.string().min(1),
    packetId: z.string().min(1),
    baseCommit: z.string().min(1),
    preparationCommits: z.array(z.string().min(1)),
    preparationHead: z.string().min(1),
    changedFiles: z.array(z.string().min(1)),
    governingDecision: z.string().min(1),
    resolvedRfc: z.string().min(1),
    materializationCommit: z.string().min(1),
    validations: z.array(preparationValidationSchema),
    cleanTrees: z.literal(true),
    preparedBy: programActorSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Program packet completion: forge/program-packet-completion@1
// ---------------------------------------------------------------------------

export const completionValidationSchema = z.object({
  command: z.string().min(1),
  status: z.literal("pass"),
  evidenceDigest: z.string().min(1),
});

export const programPacketCompletionSchema = z
  .object({
    schema: z.literal("forge/program-packet-completion@1"),
    program: z.string().min(1),
    packetId: z.string().min(1),
    baseCommit: z.string().min(1),
    sealCommit: z.string().min(1),
    implementationCommits: z.array(z.string().min(1)),
    implementationHead: z.string().min(1),
    changedFiles: z.array(z.string().min(1)),
    validations: z.array(completionValidationSchema),
    remainingTransitionDiagnostics: z.array(z.string()),
    unexpectedDiagnostics: z.array(z.string()).length(0),
    recoveryStatus: recoveryStatusSchema,
    cleanTrees: z.literal(true),
    completedBy: programActorSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Recovery record: forge/program-packet-recovery@1
// ---------------------------------------------------------------------------

export const recoveryRecordSchema = z
  .object({
    schema: z.literal("forge/program-packet-recovery@1"),
    program: z.string().min(1),
    packetId: z.string().min(1),
    previousLeaseDigest: z.string().min(1),
    reason: z.string().min(1),
    actor: programActorSchema,
    observedHead: z.string().min(1),
    target: z.enum(["blocked", "sealed"]),
    recoveredAt: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// TypeScript types (inferred from schemas)
// ---------------------------------------------------------------------------

export type ProgramActor = z.infer<typeof programActorSchema>;
export type ProgramState = z.infer<typeof programStateSchema>;
export type PacketState = z.infer<typeof packetStateSchema>;
export type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;
export type ProgramManifest = z.infer<typeof programManifestSchema>;
export type ProgramPacketIndexEntry = z.infer<typeof programPacketIndexEntrySchema>;
export type ProgramPacket = z.infer<typeof programPacketSchema>;
export type NormativeSource = z.infer<typeof normativeSourceSchema>;
export type RequiredValidation = z.infer<typeof requiredValidationSchema>;
export type ProgramLeasePhase = z.infer<typeof programLeasePhaseSchema>;
export type ProgramPacketLease = z.infer<typeof programPacketLeaseSchema>;
export type PreparationValidation = z.infer<typeof preparationValidationSchema>;
export type ProgramPacketPreparation = z.infer<typeof programPacketPreparationSchema>;
export type ProgramPacketCompletion = z.infer<typeof programPacketCompletionSchema>;
export type CompletionValidation = z.infer<typeof completionValidationSchema>;
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
