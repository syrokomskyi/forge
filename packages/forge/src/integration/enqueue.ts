/*
<MODULE_CONTRACT>
<purpose>
Enqueue path + read-only observability surfaces (Werkstatt RFC-1647) — sessions
freeze their work into immutable units and enqueue atomically; queue state is
inspectable at all times through read-only surfaces consuming frozen state only.
The conflicted-recovery contract names itself verbatim: the owning session
rebases onto the current head and re-enqueues a NEW unit — units are immutable,
re-enqueue is a new id.
</purpose>
<non-goals>
  <item>No drain triggers as daemons — enqueueing commands may trigger an on-demand drain.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1647 (WP-4): initial enqueue + observability.</item>
</CHANGE_SUMMARY>
*/

import { randomBytes } from "node:crypto";

import type { QueueStore } from "./store.ts";
import { isTerminal, type IntegrationUnit, type QueueJournalEntry } from "./types.ts";

/** uuidv7-style time-ordered id — millisecond prefix keeps FIFO sort stable. */
export function newUnitId(now = Date.now()): string {
  const timeHex = now.toString(16).padStart(12, "0");
  const rand = randomBytes(8).toString("hex");
  return `${timeHex}-${rand}`;
}

export interface EnqueueInput {
  treeDigest: string;
  baseRef: string;
  sessionId: string;
  worktreePath: string;
  governanceIds: string[];
  commitChain: string[];
}

/** Freeze-and-enqueue: the unit either exists complete in the queue or not at all. */
export function enqueueUnit(store: QueueStore, input: EnqueueInput): IntegrationUnit {
  const unit: IntegrationUnit = {
    schema: "forge:integration-unit/v1",
    id: newUnitId(),
    treeDigest: input.treeDigest,
    baseRef: input.baseRef,
    source: {
      sessionId: input.sessionId,
      worktreePath: input.worktreePath,
      governanceIds: input.governanceIds,
    },
    commitChain: input.commitChain,
    enqueuedAt: new Date().toISOString(),
    state: { status: "queued" },
    attempts: 0,
  };
  store.enqueue(unit);
  return unit;
}

export interface QueueView {
  units: Array<{
    id: string;
    status: string;
    enqueuedAt: string;
    sessionId: string;
    terminal: boolean;
  }>;
  journalTail: QueueJournalEntry[];
  liveLease: boolean;
}

/** Read-only queue state — consumes frozen records and the append-only journal only. */
export function inspectQueue(store: QueueStore, journalTailLines = 20): QueueView {
  const units = store.units().map((u) => ({
    id: u.id,
    status: u.state.status,
    enqueuedAt: u.enqueuedAt,
    sessionId: u.source.sessionId,
    terminal: isTerminal(u.state),
  }));
  const journal = store.journal();
  return {
    units,
    journalTail: journal.slice(-journalTailLines),
    liveLease: false, // lease state is operational, not evidence — callers may probe separately
  };
}

/** Verbatim recovery path named in every conflicted terminal — the agent contract. */
export const CONFLICTED_RECOVERY_INSTRUCTION =
  "This unit is terminally conflicted and is never retried in place. The owning session rebases its worktree onto the current head, resolves the named paths, freezes the result as a NEW unit and re-enqueues it — units are immutable, re-enqueue is a new id.";
