/*
<MODULE_CONTRACT>
<purpose>RFC-1568 — detach mechanics: the parent re-spawns the same CLI
  entrypoint with `--detach` stripped, stdio routed to the run's log file,
  `WERKSTATT_GATE_RUN_ID` in env so the child adopts the parent's record,
  then prints the pointer block and exits 0.</purpose>
<non-goals>
  <item>No output mirroring — detached output lives only in the log file.</item>
  <item>No waiting on the gate itself — only a ≤2 s heartbeat on the child's
    first record write, so an unspawnable child surfaces before the parent
    returns.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1568: step 3 — detachSelf with injected SpawnLike</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
</CHANGE_SUMMARY>
*/

// kernel-io-lint IO-01 carve-out (RFC-1568 / DNA-105): a detached gate is the
// "genuinely long-lived child process" class the spawn carve-out exists for.
// The spawner stays injectable — unit tests never spawn real gates.
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import type { GateRunRecord, SpawnLike } from "./types.ts";
import { gateRunsDir } from "./record.ts";

export const GATE_RUN_ID_ENV = "WERKSTATT_GATE_RUN_ID";
/** How long the parent waits for the child's first record write. */
export const HEARTBEAT_WAIT_MS = 2_000;

export interface DetachResult {
  pid: number;
  logPath: string;
  runId: string;
}

/**
 * Re-spawn the current CLI detached. `entry` is process.argv[1] of the
 * running host (`forge` bin or `werkstatt` bin); `argv` carries the command
 * and its flags minus `--detach` — for the kernel host it MUST keep the
 * leading `run` token so the child re-enters the same dispatch path.
 */
export async function detachSelf(input: {
  entry: string;
  argv: string[];
  record: GateRunRecord;
  commonGitDir: string;
  spawn?: SpawnLike;
  /** Reads the record back for the heartbeat — injected in tests. */
  recordExists?: (runId: string) => Promise<boolean>;
}): Promise<DetachResult> {
  const doSpawn: SpawnLike = input.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const logPath = join(gateRunsDir(input.commonGitDir), `${input.record.runId}.log`);
  const logFd = openSync(logPath, "a");
  try {
    // process.execArgv forwards the host's loader flags (--import tsx, …) —
    // a bare `node entry.ts` dies with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
    const child = doSpawn(process.execPath, [...process.execArgv, input.entry, ...input.argv], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, [GATE_RUN_ID_ENV]: input.record.runId },
    });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("spawn returned no pid");
    }

    // ≤2 s heartbeat — the child adopts the record by rewriting it with its
    // own pid; if that write never lands the parent reports the spawn
    // failure instead of leaving an untrackable process.
    if (input.recordExists !== undefined) {
      const deadline = Date.now() + HEARTBEAT_WAIT_MS;
      while (Date.now() < deadline) {
        if (await input.recordExists(input.record.runId)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return { pid, logPath, runId: input.record.runId };
  } finally {
    try {
      closeSync(logFd);
    } catch {
      // fd already closed — nothing to do
    }
  }
}

/** Pretty pointer block printed by the parent before exiting. */
export function detachPointerLines(
  result: DetachResult,
  commonGitDir: string,
  statusCommand: string,
): string[] {
  const relLog = result.logPath.startsWith(commonGitDir)
    ? `.git/${result.logPath.slice(commonGitDir.length + 1)}`
    : result.logPath;
  return [
    `[gate-run] started ${result.runId} (pid ${result.pid})`,
    `  log:    ${relLog}`,
    `  status: ${statusCommand} --id ${result.runId}`,
  ];
}
