/*
<MODULE_CONTRACT>
<purpose>
Transactional integration queue types (Werkstatt RFC-1647) — immutable units,
the unit state machine, drain leases, and the append-only queue journal.
Mutable bookkeeping is separated from evidence per RFC-1646.
</purpose>
<non-goals>
  <item>No drain/store logic — types only.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1647 (WP-4): initial queue contracts.</item>
</CHANGE_SUMMARY>
*/

/** Immutable unit of integration — frozen at enqueue, never mutated. */
export interface IntegrationUnit {
  schema: "forge:integration-unit/v1";
  /** uuidv7-style time-ordered id. */
  id: string;
  /** Frozen session tree — git tree object id is the content digest. */
  treeDigest: string;
  /** Governed ref digest at enqueue time. */
  baseRef: string;
  source: {
    sessionId: string;
    /** Informational only. */
    worktreePath: string;
    /** RFC/ADR/friction anchors. */
    governanceIds: string[];
  };
  /** Commit chain preserved for replay, oldest first — squash is forbidden. */
  commitChain: string[];
  enqueuedAt: string;
  state: UnitState;
  /** Crash-recovery counter, not retry-of-failure. */
  attempts: number;
}

export type UnitState =
  | { status: "queued" }
  | { status: "evaluating"; leaseId: string; since: string }
  | { status: "integrated"; commitSha: string; evidenceKey: string }
  | { status: "refused"; reason: RefusalReason; evidenceKey: string }
  | { status: "conflicted"; conflictingPaths: string[] }
  | { status: "cancelled"; by: string };

export interface RefusalReason {
  /** The blocking contract node — one explanation path. */
  nodeId: string;
  summary: string;
  violations: number;
}

export interface DrainLease {
  leaseId: string;
  workerPid: number;
  /** Same-machine fencing, inheriting the v9 machine-local trust model. */
  hostBootId: string;
  acquiredAt: string;
  /** Expiry = heartbeat + leaseTtl. */
  heartbeatAt: string;
}

export interface QueueJournalEntry {
  schema: "forge:queue-journal/v1";
  unitId: string;
  transition: "enqueued" | "evaluating" | "integrated" | "refused" | "conflicted" | "cancelled" | "requeued";
  at: string;
  /** drain:<leaseId> | session:<id> | operator */
  actor: string;
  detail?: Record<string, string>;
}

export type TerminalStatus = "integrated" | "refused" | "conflicted" | "cancelled";

export function isTerminal(state: UnitState): boolean {
  return state.status === "integrated" || state.status === "refused" || state.status === "conflicted" || state.status === "cancelled";
}
