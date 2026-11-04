/*
<MODULE_CONTRACT>
<purpose>Exclusive file locks for flow commands (RFC-1487): O_EXCL lock files
carrying { pid, host, at }, wait-with-progress while a live holder exists,
stale locks broken by age, always released in finally. Used for the short
registry lock (10 s) and the long integration lock (30 min).</purpose>
<non-goals>
  <item>No registry semantics — callers choose paths, budgets and diagnostics.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Staleness reads the lock file's `at` timestamp, not mtime — a crashed holder leaves a frozen file whose content is authoritative (DNA-105).</item>
  <item>Timeout throws LockTimeoutError naming the file — each command maps it to its own diagnostic (FLOW-07 for the registry, FLOW-INT-08 for integrate).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 1 — exclusive file locks</item>
  <item>RFC-1487: step 1 — worktree path contracts, O_EXCL locks, branch registry and journal</item>
  <item>RFC-1487: close rfc-1487 review findings — dirty-check parity with git worktree remove, ownership-verified lock release, FLOW-07 registry-error mapping, residual RFC-1462 docs removed

The dirty gate for session worktrees now uses full porcelain status
(untracked files included) because it predicts 'git worktree remove';
the primary-clean gate keeps tracked-only semantics because it predicts
'merge --ff-only'. Lock release verifies the held payload before
unlinking. Registry/journal failures map to FLOW-07 in every handler.
The final branch-name collision reports FLOW-OPEN-04, flow.discard
propagates its teardown result and predicts FLOW-DIS-03 on --dry-run,
and integrate exposes teardown as its own field.</item>
  <item>RFC-1504: steps 2-3 — holderIsDead, boot-id payload, dead-holder break in withFlowLock</item>
</CHANGE_SUMMARY>
*/

import { hostname } from "node:os";
import { open, readFile, rm } from "node:fs/promises";

import { currentBootId, holderIsDead } from "../core/lock-holder.ts";

export interface FlowLockOptions {
  /** Maximum time to wait for a live lock before throwing LockTimeoutError. */
  waitMs: number;
  /** A lock whose `at` is older than this is broken with an onStale warning. */
  staleMs: number;
  /** Emit onProgress at this interval while waiting (0/undefined = silent). */
  progressEveryMs?: number;
  onProgress?: (message: string) => void;
  /** Called when a stale lock is broken — the caller logs the warning.
   * `reason: "dead-holder"` marks an immediate dead-pid/boot-id break;
   * absent reason means the classic stale-age break. */
  onStale?: (lock: {
    path: string;
    at: string;
    ageMs: number;
    reason?: "dead-holder" | "stale-age";
    pid?: number;
    host?: string;
  }) => void;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown when the wait budget elapses while a live lock is held. */
export class LockTimeoutError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, waitedMs: number) {
    super(`lock ${lockPath} still held after ${waitedMs} ms`);
    this.name = "LockTimeoutError";
    this.lockPath = lockPath;
  }
}

interface LockFileContent {
  pid: number;
  host: string;
  at: string;
  /** RFC-1504: machine boot id when the platform has one — written only when defined. */
  bootId?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function tryAcquire(lockPath: string, content: LockFileContent): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(content));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Age of the held lock in ms; null when the file vanished or is unreadable. */
async function lockAgeMs(
  lockPath: string,
  readFile: (path: string) => Promise<string>,
  nowMs: number,
): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { at?: unknown };
    if (typeof parsed.at !== "string") return null;
    const at = Date.parse(parsed.at);
    if (Number.isNaN(at)) return null;
    return nowMs - at;
  } catch {
    return null;
  }
}

/** Holder fields of the current lock file; null when unreadable. */
async function readHolder(lockPath: string): Promise<LockFileContent | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    if (typeof parsed["pid"] !== "number") return null;
    return {
      pid: parsed["pid"],
      host: typeof parsed["host"] === "string" ? parsed["host"] : "",
      at: typeof parsed["at"] === "string" ? parsed["at"] : "",
      bootId: typeof parsed["bootId"] === "string" ? parsed["bootId"] : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Hold `lockPath` exclusively for the duration of `fn`. Waits while a live
 * holder exists, breaks a lock older than `staleMs` with an onStale warning,
 * throws LockTimeoutError when the budget elapses. The lock is always
 * released — a failed `fn` never leaks it.
 */
export async function withFlowLock<T>(
  lockPath: string,
  opts: FlowLockOptions,
  fn: () => Promise<T>,
  io: { readFile: (path: string) => Promise<string> },
): Promise<T> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + opts.waitMs;
  let nextProgress = now() + (opts.progressEveryMs ?? Number.POSITIVE_INFINITY);

  const ownBootId = currentBootId();
  let heldPayload: { pid: number; at: string } | null = null;
  for (;;) {
    const at = new Date(now()).toISOString();
    const content: LockFileContent = {
      pid: process.pid,
      host: hostname(),
      at,
    };
    if (ownBootId !== undefined) content.bootId = ownBootId;
    const acquired = await tryAcquire(lockPath, content);
    if (acquired) {
      heldPayload = { pid: process.pid, at };
      break;
    }

    // RFC-1504: a dead holder's lock is removed and retried at once —
    // before the age rule, so a crashed process never makes anyone wait.
    const holder = await readHolder(lockPath);
    if (holder !== null && holderIsDead(holder)) {
      opts.onStale?.({
        path: lockPath,
        at: holder.at,
        ageMs: 0,
        reason: "dead-holder",
        pid: holder.pid,
        host: holder.host,
      });
      await rm(lockPath, { force: true });
      continue;
    }

    const age = await lockAgeMs(lockPath, io.readFile, now());
    if (age !== null && age > opts.staleMs) {
      opts.onStale?.({
        path: lockPath,
        at: new Date(now() - age).toISOString(),
        ageMs: age,
        reason: "stale-age",
      });
      await rm(lockPath, { force: true });
      continue;
    }
    if (now() >= deadline) {
      throw new LockTimeoutError(lockPath, now() - (deadline - opts.waitMs));
    }
    if (opts.progressEveryMs && now() >= nextProgress) {
      opts.onProgress?.(`waiting for ${lockPath}`);
      nextProgress = now() + opts.progressEveryMs;
    }
    await sleep(Math.min(50, Math.max(1, deadline - now())));
  }

  try {
    return await fn();
  } finally {
    // Release only the lock we hold: after a stale-break takeover the file
    // may carry a newer holder's payload — unlinking it would leave no
    // mutual exclusion at all.
    let stillOurs = false;
    try {
      const raw = await io.readFile(lockPath);
      const parsed = JSON.parse(raw) as { pid?: number; at?: string };
      stillOurs = parsed.pid === heldPayload?.pid && parsed.at === heldPayload?.at;
    } catch {
      stillOurs = false;
    }
    // Residual TOCTOU: a takeover between the read above and this rm could
    // still unlink a fresh holder's lock — only reachable once our own lock
    // aged past staleMs, which the stale-breaker already accepts as dead.
    // A true fix needs compare-and-delete semantics the filesystem lacks.
    if (stillOurs) await rm(lockPath, { force: true });
  }
}
