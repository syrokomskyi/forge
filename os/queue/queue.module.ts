/*
<MODULE_CONTRACT>
<purpose>Register the queue.validate command with the forge kernel registry (RFC-1140).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/queue-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1250: re-review wave — blocked dependsOn cascade, manifest-failure gating, generated artifacts</item>
  <item>RFC-1350: queue-batch hardening — ledger baseline field, manifest packagesImpacted + QUEUE-09, COMMIT-GOV-02 manifest scope, test-first policy</item>
  <item>RFC-1350: review follow-ups — QUEUE-09 touched-set edge cases (empty window, quoted paths, rename source, malformed entries), strict baseline, manifest template/scope wording, generated artifacts resync</item>
  <item>RFC-1354: step 4 — CMD-MAN-02 sweep: writes/generates on mutating commands, mutatesState:false on read-only and port/in-memory commands, execOnReadOnly on subprocess commands (0 CMD-MAN-02; 42 ENV-INPUT-02 excluded per Q-1)</item>
  <item>RFC-1461: declare rules[] severity via CommandRuleDecl workspace-wide (RFC-1461)</item>
  <history>RFC-1140, RFC-1250</history>
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
          "hygiene issues (missing answers, foreign doc ids); QUEUE-09 warns " +
          "when the manifest's packagesImpacted is absent, names a non-root " +
          "entry, or names roots with no touched files since the introduction " +
          "commit while other roots are touched (RFC-1350). " +
          "Read-only — " +
          "the pipeline orchestrator runs this before a queued batch and the " +
          "decision window consumes its diagnostics (RFC-1140). " +
          "Required flags: `--file`.",
        scope: "workspace",
        contract: "queue",
        rules: [{ id: "QUEUE-01", severity: "error" }, { id: "QUEUE-02", severity: "error" }, { id: "QUEUE-03", severity: "error" }, { id: "QUEUE-04", severity: "error" }, { id: "QUEUE-05", severity: "error" }, { id: "QUEUE-06", severity: "error" }, { id: "QUEUE-07", severity: "error" }, { id: "QUEUE-08", severity: "error" }, { id: "QUEUE-09", severity: "warning" }],
        mutatesState: false,
        execOnReadOnly: true,
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
