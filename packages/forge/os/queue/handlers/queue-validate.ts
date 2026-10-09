/*
<MODULE_CONTRACT>
<purpose>queue.validate command handler (RFC-1140 + RFC-1250) — validates a
queue manifest and its decision-ledger sibling, reports derived per-item
pipeline status plus the next actionable item. QUEUE-07 blocks implementable
items carrying open decisions. Read-only; the orchestrator runs this before a
queued batch.</purpose>
<non-goals>
  <item>Do not execute the queue — this command validates and previews only.</item>
  <item>Do not mutate any files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1250: decision-ledger wiring — QUEUE-07 open-decision gate on
  implementable items, per-item decisions counts, deferred/parked-aware `next`
  with dependsOn cascade.</item>
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
import { loadDecisionLedger, loadQueueManifest } from "../manifest.ts";
import type { DecisionEntry, DecisionLedger, QueueValidateResult } from "../types.ts";

interface DecisionSummary {
  open: number;
  deferred: number;
  autoResolved: number;
  /** true when an open entry carries parked: true (hard-stop during execution). */
  parked: boolean;
}

function summarizeDecisions(ledger: DecisionLedger | null): Map<string, DecisionSummary> {
  const summaries = new Map<string, DecisionSummary>();
  if (!ledger) return summaries;
  for (const entry of ledger.items as DecisionEntry[]) {
    const doc = entry.doc.toUpperCase();
    const s = summaries.get(doc) ?? { open: 0, deferred: 0, autoResolved: 0, parked: false };
    if (entry.status === "open") {
      s.open += 1;
      if (entry.parked === true) s.parked = true;
    } else if (entry.status === "deferred") {
      s.deferred += 1;
    } else if (entry.status === "auto-resolved") {
      s.autoResolved += 1;
    }
    summaries.set(doc, s);
  }
  return summaries;
}

/**
 * RFC-1250 parking: an item is parked when its ledger carries `deferred`
 * entries (operator parked it at a window) or `open` entries with
 * `parked: true` (system hard-stop during execution). An item whose in-queue
 * `dependsOn` target is parked is itself parked — fixed-point cascade.
 */
function computeParkedDocIds(
  itemIds: string[],
  dependsOn: Map<string, string[]>,
  summaries: Map<string, DecisionSummary>,
): Set<string> {
  const parked = new Set<string>();
  for (const id of itemIds) {
    const s = summaries.get(id.toUpperCase());
    if (s && (s.deferred > 0 || s.parked)) parked.add(id.toUpperCase());
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [itemId, deps] of dependsOn) {
      if (parked.has(itemId)) continue;
      if (deps.some((dep) => parked.has(dep))) {
        parked.add(itemId);
        changed = true;
      }
    }
  }
  return parked;
}

/** QUEUE-07: an item derivable to the implement stage must not carry open decisions. */
function isImplementable(item: { status: string; pipelineStep?: string; kind?: string }): boolean {
  return item.pipelineStep === "implement" || (item.kind === "adr" && item.status === "pending");
}

export async function runQueueValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<QueueValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;

  const file = input.flags["file"] as string | undefined;
  if (!file) {
    throw new Error("queue.validate requires --file <path-to-manifest.yaml>");
  }

  const { manifest, errors, warnings, dependsOn } = await loadQueueManifest(workspaceRoot, file);

  // The ledger is part of the queue's durable state — its load errors block.
  const { ledger, errors: ledgerErrors } = await loadDecisionLedger(workspaceRoot, file);
  errors.push(...ledgerErrors);

  const summaries = summarizeDecisions(ledger);
  const parkedIds = computeParkedDocIds(
    manifest.items.map((i) => i.id),
    dependsOn,
    summaries,
  );

  const report =
    errors.length === 0
      ? await deriveQueueReport(
          workspaceRoot,
          manifest.items.map((i) => i.id),
          undefined,
          parkedIds,
        )
      : { items: [], next: null };

  for (const item of report.items) {
    const s = summaries.get(item.id);
    if (s) {
      item.decisions = {
        open: s.open,
        deferred: s.deferred,
        autoResolved: s.autoResolved,
      };
    }
  }

  for (const item of report.items) {
    const s = summaries.get(item.id);
    if (isImplementable(item) && s && s.open > 0) {
      errors.push({
        ruleId: "QUEUE-07",
        severity: "error",
        message: `Item "${item.id}" is implementable but carries ${s.open} open decision(s) — resolve the decision window first`,
        file,
      });
    }
  }

  const status = errors.length === 0 ? "pass" : "fail";

  if (outputFormat === "pretty") {
    logger.section(`Queue: ${manifest.id || file}`);
    for (const item of report.items) {
      const step = item.pipelineStep ? ` (${item.pipelineStep})` : "";
      const decisions = item.decisions
        ? ` [decisions: ${item.decisions.open} open, ${item.decisions.deferred} deferred, ${item.decisions.autoResolved} auto-resolved]`
        : "";
      logger.info(`  ${item.id}: ${item.status}${step}${decisions}`);
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
