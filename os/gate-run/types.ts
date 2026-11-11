/*
<MODULE_CONTRACT>
<purpose>RFC-1568 — durable gate-run record contract: one JSON record per
  detachable-command execution under `<git common dir>/forge/gate-runs/`,
  carrying lifecycle (running → succeeded|failed, `lost` derived), pid liveness
  inputs, and pointers at the run's log/gate-report artifacts.</purpose>
<non-goals>
  <item>No liveness rules of its own — classify delegates to os/core/lock-holder.</item>
  <item>No remote/queued execution — records are written by the runner itself.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1568: step 1 — gate-run record contract + refusal ids</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
</CHANGE_SUMMARY>
*/

export type GateRunStatus = "running" | "succeeded" | "failed" | "lost";

export const GATE_RUN_SCHEMA = "forge:gate-run/v1" as const;

export interface GateRunRecord {
  schema: typeof GATE_RUN_SCHEMA;
  /** gr-<UTC yyyymmddThhmmssZ>-<command>-<4 hex> */
  runId: string;
  command: string;
  /** argv as invoked, without --detach. */
  argv: string[];
  /** repo-relative to the common-dir parent when possible. */
  cwd: string;
  detached: boolean;
  pid: number;
  host: string;
  bootId?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  /** "running" on disk until the end write; "lost" is derived, never written. */
  status: GateRunStatus;
  /** the command result summary line. */
  summary?: string;
  /** detached runs: <common>/forge/gate-runs/<runId>.log */
  logPath?: string;
  /** RFC-1532 gate report, when the command produced one. */
  reportPath?: string;
  /** mission.validate */
  missionId?: string;
}

/** Minimal spawn surface detach.ts needs — injectable for tests. */
export interface SpawnLikeChild {
  pid?: number;
  unref(): void;
}

export interface SpawnLike {
  (
    file: string,
    args: string[],
    opts: {
      detached?: boolean;
      stdio?: unknown[];
      env?: Record<string, string | undefined>;
    },
  ): SpawnLikeChild;
}

/** GATE-RUN-01..03 — command-level refusal ids declared on gate.run.status. */
export const GATE_RUN_RULES = [
  { id: "GATE-RUN-01", severity: "error" as const },
  { id: "GATE-RUN-02", severity: "error" as const },
  { id: "GATE-RUN-03", severity: "error" as const },
];
