/*
<MODULE_CONTRACT>
<purpose>Queue manifest contract (RFC-1140) — the durable ordered document
block consumed by queue.validate and the pipeline orchestrator's queue mode.</purpose>
<non-goals>
  <item>Do not store per-item progress state — status is derived, never persisted.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1140: initial QueueManifest schema and queue.validate result types.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

import type { Diagnostic } from "../../src/types.ts";
import type { QueueItemReport } from "../../src/pipeline-status.ts";

export const QUEUE_ITEM_ID_PATTERN = /^(RFC|ADR)-\d{4}$/;

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
  /** First item whose derived status is pending or in-progress; null when fully terminal. */
  next: string | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}
