/*
<MODULE_CONTRACT>
<purpose>Shared one-shot stamp lock for rfc.implement.stamp and
adr.implement.stamp (RFC-1504): O_EXCL acquisition carrying
{pid, host, at, bootId?}; on contention the holder's file is judged —
a dead holder or a lock older than STAMP_LOCK_STALE_MS is removed and the
acquire retries once; a live or foreign holder returns acquired:false so the
caller keeps its *-IMP-05 refusal. No wait loop — stamp locks never had one.</purpose>
<non-goals>
  <item>No release — callers keep their own rm(lockPath) finally.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1504: step 4 — shared stamp lock with dead-holder break</item>
  <item>RFC-1504: step 4 — shared stamp lock for rfc and adr stamp handlers</item>
</CHANGE_SUMMARY>
*/

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { currentBootId, holderIsDead } from "./lock-holder.ts";

export const STAMP_LOCK_STALE_MS = 30 * 60 * 1000;

export interface StampLockOptions {
  /** Called when a stale or dead lock file is removed. */
  onStale?: (info: {
    path: string;
    reason: "dead-holder" | "stale-age";
    pid?: number;
    host?: string;
    ageMs?: number;
  }) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface StampLockContent {
  pid: number;
  host: string;
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
 * Acquire `lockPath` once. Returns {acquired:true} after breaking a dead or
 * stale holder, {acquired:false} while a live or foreign holder stands.
 */
export async function acquireStampLock(
  lockPath: string,
  opts: StampLockOptions = {},
): Promise<{ acquired: boolean; lockPath: string }> {
  const now = opts.now ?? (() => Date.now());
  await mkdir(dirname(lockPath), { recursive: true });
  const bootId = currentBootId();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const at = new Date(now()).toISOString();
    const content: StampLockContent = { pid: process.pid, host: hostname(), at };
    if (bootId !== undefined) content.bootId = bootId;
    if (await tryAcquire(lockPath, content)) return { acquired: true, lockPath };

    const holder = await readHolder(lockPath);
    if (holder !== null && holderIsDead(holder)) {
      opts.onStale?.({ path: lockPath, reason: "dead-holder", pid: holder.pid, host: holder.host });
      await rm(lockPath, { force: true });
      continue;
    }
    if (holder !== null && holder.at.length > 0) {
      const at_ms = Date.parse(holder.at);
      if (!Number.isNaN(at_ms) && now() - at_ms > STAMP_LOCK_STALE_MS) {
        opts.onStale?.({
          path: lockPath,
          reason: "stale-age",
          pid: holder.pid,
          host: holder.host,
          ageMs: now() - at_ms,
        });
        await rm(lockPath, { force: true });
        continue;
      }
    }
    return { acquired: false, lockPath };
  }
  return { acquired: false, lockPath };
}
