/*
<MODULE_CONTRACT>
<purpose>Liveness check for file-lock holders (RFC-1504): `holderIsDead`
decides whether the process that wrote a lock no longer exists — dead pids
are broken without waiting, foreign hosts keep the age rule, a foreign boot
id on this host means the holder died with the last boot. `currentBootId`
reads /proc/sys/kernel/random/boot_id when the platform has one.</purpose>
<non-goals>
  <item>No lock acquisition — os/flow/locks.ts and os/core/stamp-lock.ts own
  the O_EXCL path.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1504: step 2 — holderIsDead + currentBootId</item>
  <item>RFC-1504: steps 2-3 — holderIsDead, boot-id payload, dead-holder break in withFlowLock</item>
  <item>RFC-1504: review fixes — legacy acquiredAt fallback, atomic break claim, verified stamp release, onStale warnings</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { hostname } from "node:os";

export interface LockHolder {
  pid: number;
  host?: string;
  at?: string;
  bootId?: string;
}

/** The machine's boot id, or undefined on platforms without one / on any read error. */
export function currentBootId(): string | undefined {
  try {
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the recorded holder cannot exist anymore. A lock from another
 * host (or with no host at all) is never judged by pid — pid namespaces
 * differ, so the age rule stays the only breaker there. A same-host lock
 * carrying a bootId different from the current boot is dead by definition:
 * the machine restarted since it was written. Otherwise `kill(pid, 0)`
 * probes: ESRCH is dead, EPERM and success are alive; any other error is
 * treated as alive (fail closed).
 */
export function holderIsDead(lock: LockHolder, bootId: string | undefined = currentBootId()): boolean {
  if (lock.host === undefined || lock.host !== hostname()) return false;
  if (lock.bootId !== undefined && bootId !== undefined && lock.bootId !== bootId) return true;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Atomically claim the right to remove a stale/dead lock file: re-read the
 * file, verify it still carries the `expected` holder (same pid and at), and
 * rename it to a unique tombstone path. Returns the tombstone path for the
 * caller to unlink, or null when the lock changed hands in between — in
 * that case a fresh holder stands and the file must not be touched.
 * The rename is the claim: two contenders racing the same dead lock cannot
 * both land it, so a winner never deletes another contender's fresh lock.
 */
export async function claimLockBreak(
  lockPath: string,
  expected: { pid: number; at: string } | null,
): Promise<string | null> {
  const tombPath = `${lockPath}.tomb.${process.pid}.${Date.now()}`;
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    if (expected !== null) {
      const at = typeof current["at"] === "string" ? current["at"]
        : typeof current["acquiredAt"] === "string" ? current["acquiredAt"]
        : "";
      if (current["pid"] !== expected.pid || at !== expected.at) return null;
    }
    await rename(lockPath, tombPath);
    return tombPath;
  } catch {
    return null;
  }
}
