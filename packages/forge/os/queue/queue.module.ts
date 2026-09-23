/*
<MODULE_CONTRACT>
<purpose>Register the queue.validate command with the forge kernel registry (RFC-1140).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/queue-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1140: initial forgeQueueModule registering queue.validate.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
  <item>RFC-1140: queue.validate missing contract/rules metadata (DNA-91)

fo-review REVIEW-CODE-2026-09-23-01 finding: declare contract queue and emitted ruleIds QUEUE-01..06 so validator.inventory.generate does not fail closed. Manifest regenerated.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeQueueModule(): Promise<ForgeModule> {
  const { runQueueValidate } = await import("./handlers/queue-validate.ts");
  return {
    name: "forge-queue",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "queue.validate",
        description:
          "Validate a queue manifest (docs/queues/*.yaml) and report derived " +
          "per-item pipeline status plus the next actionable item. Read-only — " +
          "the pipeline orchestrator runs this before starting a queued batch (RFC-1140).",
        scope: "workspace",
        contract: "queue",
        rules: ["QUEUE-01", "QUEUE-02", "QUEUE-03", "QUEUE-04", "QUEUE-05", "QUEUE-06"],
        mutatesState: false,
        reads: [
          "docs/queues/*.yaml",
          "docs/rfcs/**/*.md",
          "docs/adrs/**/*.md",
          "docs/audits/*.md",
          "docs/plans/*.md",
        ],
        cacheable: false,
        flags: {
          file: {
            kind: "string",
            required: true,
            description: "Path to the queue manifest YAML file.",
          },
        },
        execute: runQueueValidate,
      },
    ],
    pipelines: [],
  };
}
