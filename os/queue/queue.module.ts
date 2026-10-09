/*
<MODULE_CONTRACT>
<purpose>Register the queue.validate command with the forge kernel registry (RFC-1140).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/queue-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1250: QUEUE-07 registered (non-parked opens only — parked entries are
  already execution-gated); QUEUE-08 ledger-hygiene warnings; reads gains the
  decisions-ledger glob.</item>
  <item>RFC-1140: initial forgeQueueModule registering queue.validate.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
  <item>RFC-1140: queue.validate missing contract/rules metadata (DNA-91)

fo-review REVIEW-CODE-2026-09-23-01 finding: declare contract queue and emitted ruleIds QUEUE-01..06 so validator.inventory.generate does not fail closed. Manifest regenerated.</item>
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
          "Validate a queue manifest (docs/queues/*.yaml) and its decision " +
          "ledger sibling, report derived per-item pipeline status plus the " +
          "next actionable item. QUEUE-07 blocks implementable items carrying " +
          "un-parked open decisions (RFC-1250); QUEUE-08 warns on ledger " +
          "hygiene issues (missing answers, foreign doc ids). Read-only — " +
          "the pipeline orchestrator runs this before a queued batch and the " +
          "decision window consumes its diagnostics (RFC-1140). " +
          "Required flags: `--file`.",
        scope: "workspace",
        contract: "queue",
        rules: [
          "QUEUE-01",
          "QUEUE-02",
          "QUEUE-03",
          "QUEUE-04",
          "QUEUE-05",
          "QUEUE-06",
          "QUEUE-07",
          "QUEUE-08",
        ],
        mutatesState: false,
        reads: [
          "docs/queues/*.yaml",
          "docs/queues/*.decisions.yaml",
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
