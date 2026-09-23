/*
<MODULE_CONTRACT>
<purpose>queue.validate command handler (RFC-1140) — validates a queue
manifest and reports derived per-item pipeline status plus the next
actionable item. Read-only; the orchestrator runs this before a queued batch.</purpose>
<non-goals>
  <item>Do not execute the queue — this command validates and previews only.</item>
  <item>Do not mutate any files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1140: initial queue.validate handler.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { deriveQueueReport } from "../../../src/pipeline-status.ts";
import { loadQueueManifest } from "../manifest.ts";
import type { QueueValidateResult } from "../types.ts";

export async function runQueueValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<QueueValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;

  const file = input.flags["file"] as string | undefined;
  if (!file) {
    throw new Error("queue.validate requires --file <path-to-manifest.yaml>");
  }

  const { manifest, errors, warnings } = await loadQueueManifest(workspaceRoot, file);

  const report =
    errors.length === 0
      ? await deriveQueueReport(
          workspaceRoot,
          manifest.items.map((i) => i.id),
        )
      : { items: [], next: null };

  const status = errors.length === 0 ? "pass" : "fail";

  if (outputFormat === "pretty") {
    logger.section(`Queue: ${manifest.id || file}`);
    for (const item of report.items) {
      const step = item.pipelineStep ? ` (${item.pipelineStep})` : "";
      logger.info(`  ${item.id}: ${item.status}${step}`);
    }
    logger.info(`next: ${report.next ?? "—"}`);
    for (const w of warnings) {
      logger.warn(`  ${w.ruleId}: ${w.message}`);
    }
    for (const e of errors) {
      logger.error(`  ${e.ruleId}: ${e.message}`);
    }
  }

  return {
    data: {
      command: "queue.validate",
      status,
      queue: manifest.id,
      file,
      items: report.items,
      next: report.next,
      errors,
      warnings,
    },
    summary:
      status === "pass"
        ? `Queue "${manifest.id}": ${report.items.length} item(s), next: ${report.next ?? "none"}`
        : `Queue manifest invalid: ${errors.length} error(s)`,
    exitCode: status === "pass" ? 0 : 1,
  };
}
