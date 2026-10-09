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
  executable items (un-parked opens only; parked items are already gated),
  per-item decisions counts plus top-level totals, `next` excludes parked and
  QUEUE-07-blocked items with dependsOn cascade.</item>
  <item>RFC-1140: initial queue.validate handler.</item>
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
  <item>RFC-1250: re-review wave — blocked dependsOn cascade, manifest-failure gating, generated artifacts</item>
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
  /** Open entries WITHOUT parked: true — the QUEUE-07 blocking subset. */
  openUnparked: number;
  answered: number;
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
    const s = summaries.get(doc) ?? {
      open: 0,
      openUnparked: 0,
      answered: 0,
      deferred: 0,
      autoResolved: 0,
      parked: false,
    };
    if (entry.status === "open") {
      s.open += 1;
      if (entry.parked === true) {
        s.parked = true;
      } else {
        s.openUnparked += 1;
      }
    } else if (entry.status === "answered") {
      s.answered += 1;
    } else if (entry.status === "deferred") {
      s.deferred += 1;
    } else if (entry.status === "auto-resolved") {
      s.autoResolved += 1;
    }
    summaries.set(doc, s);
  }
  return summaries;
}

/** Fixed-point `dependsOn` cascade: a dependent of an excluded root is excluded. */
function cascadeDependents(
  roots: ReadonlySet<string>,
  dependsOn: Map<string, string[]>,
): Set<string> {
  const excluded = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [itemId, deps] of dependsOn) {
      if (excluded.has(itemId)) continue;
      if (deps.some((dep) => excluded.has(dep))) {
        excluded.add(itemId);
        changed = true;
      }
    }
  }
  return excluded;
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
  const roots = new Set<string>();
  for (const id of itemIds) {
    const s = summaries.get(id.toUpperCase());
    if (s && (s.deferred > 0 || s.parked)) roots.add(id.toUpperCase());
  }
  return cascadeDependents(roots, dependsOn);
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
  const {
    ledger,
    errors: ledgerErrors,
    warnings: ledgerWarnings,
  } = await loadDecisionLedger(workspaceRoot, file, manifest);
  errors.push(...ledgerErrors);
  warnings.push(...ledgerWarnings);

  const summaries = summarizeDecisions(ledger);
  const parkedIds = computeParkedDocIds(
    manifest.items.map((i) => i.id),
    dependsOn,
    summaries,
  );

  // QUEUE-07: an executable item — implementable and not already parked —
  // must not carry un-parked open decisions. Parked items are already
  // excluded from execution by the park itself; their opens surface through
  // the decision window's arbitration, not a second gate.
  const derivable =
    errors.length === 0
      ? await deriveQueueReport(
          workspaceRoot,
          manifest.items.map((i) => i.id),
        )
      : { items: [], next: null };

  const blockedIds = new Set<string>();
  for (const item of derivable.items) {
    const s = summaries.get(item.id);
    if (isImplementable(item) && !parkedIds.has(item.id) && s && s.openUnparked > 0) {
      blockedIds.add(item.id);
      errors.push({
        ruleId: "QUEUE-07",
        severity: "error",
        message: `Item "${item.id}" is implementable but carries ${s.openUnparked} open decision(s) — resolve the decision window first`,
        file,
      });
    }
  }

  // Excluded from `next`: parked items, QUEUE-07-blocked items, and the
  // dependsOn dependents of either — a dependent must not execute while its
  // dependency sits unresolved behind the window.
  const excludedFromNext = new Set([...parkedIds, ...cascadeDependents(blockedIds, dependsOn)]);
  const report = {
    items: derivable.items,
    next:
      derivable.items.find(
        (i) =>
          (i.status === "pending" || i.status === "in-progress") && !excludedFromNext.has(i.id),
      )?.id ?? null,
  };

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

  const status = errors.length === 0 ? "pass" : "fail";

  const decisionTotals = ledger
    ? {
        open: ledger.items.filter((e) => e.status === "open").length,
        answered: ledger.items.filter((e) => e.status === "answered").length,
        deferred: ledger.items.filter((e) => e.status === "deferred").length,
        autoResolved: ledger.items.filter((e) => e.status === "auto-resolved").length,
      }
    : undefined;

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
    if (decisionTotals) {
      logger.info(
        `decisions: ${decisionTotals.open} open, ${decisionTotals.answered} answered, ${decisionTotals.autoResolved} auto-resolved, ${decisionTotals.deferred} deferred`,
      );
    }
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
      decisions: decisionTotals,
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
