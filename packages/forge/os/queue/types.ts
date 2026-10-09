/*
<MODULE_CONTRACT>
<purpose>Queue manifest contract (RFC-1140) — the durable ordered document
block consumed by queue.validate and the pipeline orchestrator's queue mode.</purpose>
<non-goals>
  <item>Do not store per-item progress state — status is derived, never persisted.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1250: decision-ledger schemas — DecisionLedger, DecisionEntry, DecisionStatus, policies.</item>
  <item>RFC-1140: initial QueueManifest schema and queue.validate result types.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
  <item>RFC-1250: review wave — QUEUE-07 gates un-parked opens only, ledger binding checks, fail-closed loader

REVIEW-RFC-1250-01 findings: QUEUE-07 no longer fires on parked entries
(the park is the containment — a parked queue stays resumable and the
decision window arbitrates it); loader fails open only on ENOENT —
other read errors are QUEUE-01; ledger gains queue/id-stem binding
(QUEUE-02), Q-N uniqueness (QUEUE-05), and QUEUE-08 hygiene warnings
(missing answers, foreign doc ids); next excludes QUEUE-07-blocked
items; top-level decision totals added. Orchestrator pre-flight treats
QUEUE-07 as the window agenda — structural errors still stop the batch;
maturation skips parked/deferred items; uncovered imperative ask sites
gain collect riders (ADR code-trace, NC markers, audit-verdict guard).</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

import type { Diagnostic } from "../../src/types.ts";
import type { QueueItemReport } from "../../src/pipeline-status.ts";

export const QUEUE_ITEM_ID_PATTERN = /^(RFC|ADR)-\d{4}$/;

export const DECISION_STATUS = ["open", "answered", "auto-resolved", "deferred"] as const;
export type DecisionStatus = (typeof DECISION_STATUS)[number];

export const decisionOptionSchema = z.object({
  label: z.string().min(1),
  consequence: z.string().optional(),
  recommended: z.boolean().optional(),
});

export const decisionEntrySchema = z.object({
  id: z.string().regex(/^Q-\d+$/),
  doc: z.string().regex(QUEUE_ITEM_ID_PATTERN),
  stage: z.enum(["idea", "enhance", "plan", "implement", "review"]),
  question: z.string().min(1),
  resolutionPath: z.enum(["codebase", "convention", "profile", "policy", "none"]),
  options: z.array(decisionOptionSchema).default([]),
  status: z.enum(DECISION_STATUS).default("open"),
  answer: z.string().optional(),
  answeredAt: z.string().optional(),
  parked: z.boolean().optional(),
});

export const decisionPolicySchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  appliesTo: z.union([z.literal("*"), z.array(z.string())]),
});

export const decisionLedgerSchema = z.object({
  id: z.string().min(1),
  queue: z.string().min(1),
  createdAt: z.string().min(1),
  policies: z.array(decisionPolicySchema).default([]),
  items: z.array(decisionEntrySchema).default([]),
});

export type DecisionEntry = z.infer<typeof decisionEntrySchema>;
export type DecisionLedger = z.infer<typeof decisionLedgerSchema>;

export const queueManifestSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        note: z.string().optional(),
      }),
    )
    .default([]),
});

export type QueueManifest = z.infer<typeof queueManifestSchema>;

export interface QueueValidateResult {
  command: "queue.validate";
  status: "pass" | "fail";
  queue: string;
  file: string;
  items: QueueItemReport[];
  /** First actionable item — pending/in-progress, not parked or QUEUE-07-blocked; null when none. */
  next: string | null;
  /** Aggregate decision counts across the ledger (present when a sibling ledger exists). */
  decisions?: { open: number; answered: number; deferred: number; autoResolved: number };
  errors: Diagnostic[];
  warnings: Diagnostic[];
}
