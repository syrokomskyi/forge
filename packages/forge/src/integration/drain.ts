/*
<MODULE_CONTRACT>
<purpose>
On-demand drain worker (Werkstatt RFC-1647) — strict FIFO, single logical writer:
lease, rebase-materialize the frozen unit onto the current head, evaluate the
candidate tree through the contract graph, integrate or refuse, loop until the
queue is empty, exit. Never a daemon. Idempotent recovery: lease expiry plus
state-machine re-entry; integration verified by commit existence before
re-creation — no orphan states.
</purpose>
<non-goals>
  <item>No parallelism, no speculative pre-evaluation — strict FIFO v1.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1647 (WP-4): initial drain worker.</item>
</CHANGE_SUMMARY>
*/

import { evaluateGraph, type EvaluationReport } from "../contract/evaluator.ts";
import type { ContractGraph } from "../contract/graph.ts";
import type { EvidenceStore } from "../contract/evidence-store.ts";
import type { Executor } from "../contract/evaluator.ts";
import type { ChangeUnit } from "../contract/types.ts";

import {
  commitExists,
  commitTreeEquals,
  integrateCandidate,
  replayChainOntoHead,
  resolveRef,
  type GitExec,
  defaultGitExec,
} from "./gitops.ts";
import { acquireLease, type LeaseHandle } from "./lease.ts";
import type { QueueStore } from "./store.ts";
import { isTerminal, type IntegrationUnit, type QueueJournalEntry } from "./types.ts";

/** Bound on infra-failure requeues before terminal refusal — poison-pill protection. */
export const MAX_INFRA_REQUEUE_ATTEMPTS = 5;

export interface DrainOptions {
  store: QueueStore;
  repoDir: string;
  governedRef: string;
  graph: ContractGraph;
  evidenceStore: EvidenceStore;
  executors: Record<string, Executor>;
  git?: GitExec;
  /** Test hook — a drain that evaluates without an evidence store round trip. */
  treeMaterializer?: (repoDir: string, treeDigest: string) => string;
}

export interface DrainReport {
  status: "drained" | "drain-in-progress" | "empty";
  processed: Array<{ unitId: string; terminal: string }>;
}

function journal(store: QueueStore, entry: Omit<QueueJournalEntry, "schema" | "at">): void {
  store.appendJournal({
    schema: "forge:queue-journal/v1",
    at: new Date().toISOString(),
    ...entry,
  });
}

function transition(
  store: QueueStore,
  unit: IntegrationUnit,
  state: IntegrationUnit["state"],
  actor: string,
): void {
  unit.state = state;
  store.writeUnit(unit);
  journal(store, {
    unitId: unit.id,
    transition: state.status === "evaluating" ? "evaluating" : (state.status as QueueJournalEntry["transition"]),
    actor,
    detail: state.status === "refused" ? { nodeId: state.reason.nodeId, summary: state.reason.summary } : undefined,
  });
}

/**
 * Re-entry normalization: a unit in non-terminal state after lease expiry is
 * either already landed (verify by commit existence — idempotency by
 * verification, not assumption) or safely reprocessable. Returns true when the
 * unit still needs processing.
 */
function normalizeForReentry(
  git: GitExec,
  store: QueueStore,
  repoDir: string,
  unit: IntegrationUnit,
  governedRef: string,
  actor: string,
): boolean {
  if (isTerminal(unit.state)) return false;
  if (unit.state.status === "evaluating") {
    // Did the in-flight integration actually land? The governed ref tip equality
    // is the verification — tree digest preimage, never assumption.
    try {
      const tip = resolveRef(git, repoDir, governedRef);
      if (commitExists(git, repoDir, tip) && commitTreeEquals(git, repoDir, tip, unit.treeDigest)) {
        transition(store, unit, { status: "integrated", commitSha: tip, evidenceKey: "recovered-by-verification" }, actor);
        return false;
      }
    } catch {
      // unverifiable — fall through to requeue
    }
    unit.attempts += 1;
    transition(store, unit, { status: "queued" }, actor);
  }
  return true;
}

async function processUnit(
  options: DrainOptions,
  lease: LeaseHandle,
  unit: IntegrationUnit,
): Promise<void> {
  const { store, repoDir, governedRef, graph, evidenceStore, executors } = options;
  const git = options.git ?? defaultGitExec;
  const actor = `drain:${lease.lease.leaseId}`;

  transition(store, unit, { status: "evaluating", leaseId: lease.lease.leaseId, since: new Date().toISOString() }, actor);

  // Rebase-materialize against the ACTUAL current head — the single-writer
  // guarantee makes this stable inside the drain.
  const headSha = resolveRef(git, repoDir, governedRef);
  const replay = replayChainOntoHead(git, repoDir, headSha, unit.commitChain);

  if (!replay.ok) {
    // Terminal conflicted — the owning session rebases and re-enqueues a NEW unit.
    transition(store, unit, { status: "conflicted", conflictingPaths: replay.conflictingPaths }, actor);
    return;
  }

  // The graph evaluates the candidate tree — the exact content that would
  // integrate, never the session's private tree.
  const changeUnit: ChangeUnit = {
    id: `unit-${unit.id}`,
    treeDigest: replay.candidateTree,
    baseRef: governedRef,
    createdAt: new Date().toISOString(),
    frozenRefs: { [governedRef]: headSha },
    metadata: { integrationUnit: unit.id },
  };
  const treeRoot = options.treeMaterializer
    ? options.treeMaterializer(repoDir, replay.candidateTree)
    : repoDir;

  let report: EvaluationReport;
  try {
    report = await evaluateGraph({
      graph,
      store: evidenceStore,
      changeUnit,
      executors,
      treeRoot,
    });
  } catch (err) {
    // Evaluation infrastructure failure is NOT a verdict — requeue for a later drain.
    // Bounded: a poison-pill unit must not hang the queue forever — after the bound,
    // terminal refusal carries the error as evidence of an unhealthy system.
    unit.attempts += 1;
    if (unit.attempts > MAX_INFRA_REQUEUE_ATTEMPTS) {
      transition(
        store,
        unit,
        {
          status: "refused",
          reason: {
            nodeId: "core.integration.infra",
            summary: `evaluation infrastructure failed ${unit.attempts} times: ${err instanceof Error ? err.message : String(err)}`,
            violations: 0,
          },
          evidenceKey: "",
        },
        actor,
      );
      return;
    }
    transition(store, unit, { status: "queued" }, actor);
    return;
  }

  if (!report.blockingPassed) {
    const blocking = report.nodes.find((n) => {
      const node = graph.nodes[n.nodeId];
      return node?.severity === "blocking" && n.verdict.status !== "pass" && n.verdict.status !== "uncacheable-pass";
    });
    const violations =
      blocking?.verdict.status === "fail" ? blocking.verdict.violations.length : 1;
    transition(
      store,
      unit,
      {
        status: "refused",
        reason: {
          nodeId: blocking?.nodeId ?? "core.unknown",
          summary:
            blocking?.verdict.status === "error"
              ? `executor error: ${blocking.verdict.message}`
              : `${violations} blocking violation(s)`,
          violations,
        },
        evidenceKey: blocking?.evidenceKey ?? "",
      },
      actor,
    );
    return;
  }

  // Green evaluation — integrate the candidate into the governed ref (single write point).
  integrateCandidate(git, repoDir, governedRef, replay.candidateCommit);
  transition(
    store,
    unit,
    {
      status: "integrated",
      commitSha: replay.candidateCommit,
      evidenceKey: report.nodes.find((n) => n.evidenceKey)?.evidenceKey ?? "",
    },
    actor,
  );
}

/**
 * Drain the queue once, strict FIFO, exiting when empty. A second concurrent
 * drain reports drain-in-progress and exits 0 — it never double-processes.
 */
export async function drainQueue(options: DrainOptions): Promise<DrainReport> {
  const git = options.git ?? defaultGitExec;
  const lease = acquireLease(options.store.queueDir);
  if (!lease) {
    return { status: "drain-in-progress", processed: [] };
  }

  const processed: Array<{ unitId: string; terminal: string }> = [];
  try {
    for (;;) {
      lease.heartbeat(); // per-unit boundary — fresh heartbeat each iteration
      const live = options.store
        .units()
        .filter((u) => !isTerminal(u.state))
        .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || a.id.localeCompare(b.id));

      if (live.length === 0) {
        store_checkpoint(options.store);
        return { status: processed.length > 0 ? "drained" : "empty", processed };
      }

      const unit = live[0]!;
      if (!normalizeForReentry(git, options.store, options.repoDir, unit, options.governedRef, `drain:${lease.lease.leaseId}`)) {
        continue;
      }
      await processUnit(options, lease, unit);
      const final = options.store.readUnit(unit.id);
      processed.push({ unitId: unit.id, terminal: final?.state.status ?? "unknown" });
    }
  } finally {
    lease.release();
  }
}

function store_checkpoint(store: QueueStore): void {
  try {
    store.checkpoint();
  } catch {
    // checkpoint failure never blocks a drain verdict
  }
}
