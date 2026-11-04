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
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export interface LockHolder {
  pid: number;
  host?: string;
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
export function holderIsDead(lock: LockHolder): boolean {
  if (lock.host === undefined || lock.host !== hostname()) return false;
  const boot = currentBootId();
  if (lock.bootId !== undefined && boot !== undefined && lock.bootId !== boot) return true;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
