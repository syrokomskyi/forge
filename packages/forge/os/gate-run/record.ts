/*
<MODULE_CONTRACT>
<purpose>RFC-1568 — gate-run record lifecycle: start/finish writes (atomic
  via fs-atomic), list, and liveness classification. Records live at
  `<git common dir>/forge/gate-runs/` — shared across worktrees, never
  committed. `lost` is derived at read time through `holderIsDead`, never
  persisted.</purpose>
<non-goals>
  <item>No command dispatch — hosts wrap execute() with these helpers.</item>
  <item>No process management — a running record whose holder dies stays on
    disk; classify reports it `lost`.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1568: step 2 — record lifecycle, classifyGateRun, retention</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
</CHANGE_SUMMARY>
*/

import { hostname } from "node:os";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";

import type { WorkspaceIO } from "../../src/types.ts";
import { writeFileAtomic } from "../../src/utils/fs-atomic.ts";
import { currentBootId, holderIsDead } from "../core/lock-holder.ts";
import type { GateRunRecord, GateRunStatus } from "./types.ts";
import { GATE_RUN_SCHEMA } from "./types.ts";

export const GATE_RUNS_DIR = "forge/gate-runs";
/** Newest records kept per command — running records are never deleted. */
export const GATE_RUN_RETENTION = 50;

export function gateRunsDir(commonGitDir: string): string {
  return join(commonGitDir, GATE_RUNS_DIR);
}

function makeRunId(command: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `gr-${stamp}-${command}-${randomBytes(2).toString("hex")}`;
}

function recordPath(commonGitDir: string, runId: string): string {
  return join(gateRunsDir(commonGitDir), `${runId}.json`);
}

/** Atomic record persist — the only write path for gate-run files. */
export async function saveGateRun(
  commonGitDir: string,
  record: GateRunRecord,
  io: WorkspaceIO,
): Promise<void> {
  const dir = gateRunsDir(commonGitDir);
  await io.mkdir(dir);
  await writeFileAtomic(recordPath(commonGitDir, record.runId), JSON.stringify(record, null, 2));
}

/**
 * Retention — delete records+logs beyond the newest GATE_RUN_RETENTION per
 * command. `status: running` records are exempt: the 51st queued run must
 * not erase visibility of a still-running gate.
 */
async function applyRetention(
  commonGitDir: string,
  command: string,
  io: WorkspaceIO,
): Promise<void> {
  const runs = await listGateRuns(commonGitDir, io, { command });
  const deletable = runs.filter((r) => r.status !== "running").slice(GATE_RUN_RETENTION);
  for (const stale of deletable) {
    try {
      await io.rm(recordPath(commonGitDir, stale.runId));
      if (stale.logPath) {
        await io.rm(join(gateRunsDir(commonGitDir), `${stale.runId}.log`));
      }
    } catch {
      // retention is best-effort — a busy file system never blocks the gate
    }
  }
}

/**
 * Start a gate run. The detached child re-invokes with `input.runId` set
 * (WERKSTATT_GATE_RUN_ID) and adopts the parent's record instead of creating
 * a second one — its own pid overwrites the parent's.
 */
export async function startGateRun(input: {
  commonGitDir: string;
  command: string;
  argv: string[];
  cwd: string;
  detached: boolean;
  io: WorkspaceIO;
  /** child of a detached parent passes the parent's run id. */
  runId?: string;
  missionId?: string;
}): Promise<GateRunRecord> {
  const runId = input.runId ?? makeRunId(input.command);
  const record: GateRunRecord = {
    schema: GATE_RUN_SCHEMA,
    runId,
    command: input.command,
    argv: input.argv,
    cwd: input.cwd,
    detached: input.detached,
    pid: process.pid,
    host: hostname(),
    bootId: currentBootId(),
    startedAt: new Date().toISOString(),
    status: "running",
    ...(input.missionId ? { missionId: input.missionId } : {}),
  };
  await saveGateRun(input.commonGitDir, record, input.io);
  if (input.runId === undefined) {
    // retention is a start-side concern — never on the adopting child write.
    await applyRetention(input.commonGitDir, input.command, input.io);
  }
  return record;
}

/** Final write — endedAt, exit code, summary, optional gate-report pointer. */
export async function finishGateRun(
  commonGitDir: string,
  record: GateRunRecord,
  result: { exitCode: number; summary?: string; reportPath?: string },
  io: WorkspaceIO,
): Promise<void> {
  const finished: GateRunRecord = {
    ...record,
    endedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    status: result.exitCode === 0 ? "succeeded" : "failed",
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.reportPath ? { reportPath: result.reportPath } : {}),
  };
  await saveGateRun(commonGitDir, finished, io);
}

/**
 * Newest-first listing. Corrupt records are skipped with a warn through
 * `io` — a torn write must never break the status command.
 */
export async function listGateRuns(
  commonGitDir: string,
  io: WorkspaceIO,
  filter?: { command?: string; limit?: number },
): Promise<GateRunRecord[]> {
  const dir = gateRunsDir(commonGitDir);
  let names: Awaited<ReturnType<WorkspaceIO["readdir"]>>;
  try {
    names = await io.readdir(dir);
  } catch {
    return [];
  }
  const out: GateRunRecord[] = [];
  for (const entry of names) {
    if (!entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await io.readFile(join(dir, entry.name))) as GateRunRecord;
      if (parsed.schema !== GATE_RUN_SCHEMA || typeof parsed.runId !== "string") continue;
      if (filter?.command !== undefined && parsed.command !== filter.command) continue;
      out.push(parsed);
    } catch {
      // corrupt record — skip, never throw (RFC-1568 tolerance rule)
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return filter?.limit !== undefined ? out.slice(0, filter.limit) : out;
}

/**
 * running → lost when the holder is dead under the same liveness rule the
 * flow locks use (same-host pid probe + boot id). Never writes — the record
 * on disk keeps `status: running`.
 */
export function classifyGateRun(
  record: GateRunRecord,
  ownBootId: string | undefined = currentBootId(),
): GateRunStatus {
  if (record.status !== "running") return record.status;
  if (holderIsDead({ pid: record.pid, host: record.host, bootId: record.bootId }, ownBootId)) {
    return "lost";
  }
  return "running";
}

/** The `cwd` field — relative to the common dir's parent (repo root) when possible. */
export function repoRelativeCwd(commonGitDir: string, cwd: string): string {
  const rel = relative(join(commonGitDir, ".."), cwd);
  return rel === "" || rel.startsWith("..") ? cwd : rel;
}
