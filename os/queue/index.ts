/*
<MODULE_CONTRACT>
<purpose>Barrel export for the forge queue module (RFC-1140).</purpose>
<non-goals>
  <item>Do not add logic here — re-exports only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1140: initial barrel export.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
</CHANGE_SUMMARY>
*/

export { createForgeQueueModule } from "./queue.module.ts";
export { loadQueueManifest } from "./manifest.ts";
export { queueManifestSchema, QUEUE_ITEM_ID_PATTERN } from "./types.ts";
export type { QueueManifest, QueueValidateResult } from "./types.ts";
