/*
<MODULE_CONTRACT>
<purpose>Shared one-shot stamp lock for rfc.implement.stamp and
adr.implement.stamp (RFC-1504): O_EXCL acquisition carrying
{pid, host, at, bootId?}; on contention the holder's file is judged —
a dead holder or a lock older than STAMP_LOCK_STALE_MS is claimed by an
atomic rename and removed, then the acquire retries (bounded attempts);
a live or foreign holder returns acquired:false so the caller keeps its
IMP-05 refusal. Legacy lock files written as {pid, acquiredAt} have no
host — they are judged by age only, reading acquiredAt when at is absent.
No wait loop — stamp locks never had one.</purpose>
<non-goals>
  <item>No release — callers keep their own verified rm(lockPath).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1504: step 4 — shared stamp lock with dead-holder break</item>
  <item>RFC-1504: review fixes — acquiredAt fallback, atomic break claim, held payload for verified release</item>
</CHANGE_SUMMARY>
*/

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { claimLockBreak, currentBootId, holderIsDead } from "./lock-holder.ts";

export const STAMP_LOCK_STALE_MS = 30 * 60 * 1000;

export interface StampLockOptions {
  /** Called when a stale or dead lock file is removed. */
  onStale?: (info: {
    path: string;
    reason: "dead-holder" | "stale-age";
    at?: string;
    pid?: number;
    host?: string;
    ageMs?: number;
  }) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface StampLockHeld {
  pid: number;
  at: string;
}

interface StampLockContent {
  pid: number;
  host?: string;
  at: string;
  bootId?: string;
}

async function tryAcquire(lockPath: string, content: StampLockContent): Promise<boolean> {
  try {
    await writeFile(lockPath, JSON.stringify(content), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function readHolder(lockPath: string): Promise<StampLockContent | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    if (typeof parsed["pid"] !== "number") return null;
    // RFC-1504: legacy locks carry acquiredAt instead of at — read either.
    const at = typeof parsed["at"] === "string" ? parsed["at"]
      : typeof parsed["acquiredAt"] === "string" ? parsed["acquiredAt"]
      : "";
    return {
      pid: parsed["pid"],
      host: typeof parsed["host"] === "string" ? parsed["host"] : undefined,
      at,
      bootId: typeof parsed["bootId"] === "string" ? parsed["bootId"] : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Acquire `lockPath` once. Returns {acquired:true, held} after claiming and
 * removing a dead or stale holder, {acquired:false} while a live or foreign
 * holder stands. `held` is the payload just written — pass it to a verified
 * release so a lock taken over mid-run is never deleted.
 */
export async function acquireStampLock(
  lockPath: string,
  opts: StampLockOptions = {},
): Promise<{ acquired: boolean; lockPath: string; held?: StampLockHeld }> {
  const now = opts.now ?? (() => Date.now());
  await mkdir(dirname(lockPath), { recursive: true });
  const bootId = currentBootId();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const at = new Date(now()).toISOString();
    const content: StampLockContent = { pid: process.pid, host: hostname(), at };
    if (bootId !== undefined) content.bootId = bootId;
    if (await tryAcquire(lockPath, content)) {
      return { acquired: true, lockPath, held: { pid: process.pid, at } };
    }

    const holder = await readHolder(lockPath);
    const heldAtMs = holder !== null && holder.at.length > 0 ? Date.parse(holder.at) : NaN;
    const ageMs = Number.isNaN(heldAtMs) ? NaN : now() - heldAtMs;

    if (holder !== null && holderIsDead(holder, bootId)) {
      opts.onStale?.({
        path: lockPath,
        reason: "dead-holder",
        at: holder.at,
        pid: holder.pid,
        host: holder.host,
        ageMs: Number.isNaN(ageMs) ? undefined : ageMs,
      });
      // Atomic claim: only the contender whose rename lands removes the file —
      // a loser racing the same dead lock gets null and retries normally.
      const tomb = await claimLockBreak(lockPath, holder);
      if (tomb !== null) await rm(tomb, { force: true });
      continue;
    }
    if (!Number.isNaN(ageMs) && ageMs > STAMP_LOCK_STALE_MS) {
      opts.onStale?.({
        path: lockPath,
        reason: "stale-age",
        at: holder?.at,
        pid: holder?.pid,
        host: holder?.host,
        ageMs,
      });
      const tomb = await claimLockBreak(lockPath, holder);
      if (tomb !== null) await rm(tomb, { force: true });
      continue;
    }
    return { acquired: false, lockPath };
  }
  return { acquired: false, lockPath };
}
