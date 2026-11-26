/*
<MODULE_CONTRACT>
<purpose>
Drain lease machinery (Werkstatt RFC-1647) — atomic acquisition, heartbeat, expiry
and reclaim, same-machine boot-id fencing inheriting the v9 machine-local trust
model. Lease is per-unit-processing, re-acquired with a fresh heartbeat at each
unit boundary; heartbeat cadence strictly less than half the TTL. Worst-case
duplicate work is one unit evaluation, never one corruption.
</purpose>
<non-goals>
  <item>No multi-host fencing — v1 is single-machine scope by design.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1647 (WP-4): initial lease machinery.</item>
</CHANGE_SUMMARY>
*/

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { DrainLease } from "./types.ts";

/** Lease TTL in ms — minutes-scale per RFC; heartbeat cadence must be < ttl/2. */
export const LEASE_TTL_MS = 5 * 60 * 1000;
export const HEARTBEAT_CADENCE_MS = 60 * 1000; // < LEASE_TTL_MS / 2 — fixed relationship

function hostBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    // Non-Linux fallback: machine+process start is the best available fence in v1 scope.
    return `unknown-${process.pid}`;
  }
}

export interface LeaseHandle {
  lease: DrainLease;
  heartbeat(): void;
  release(): void;
}

function readLease(path: string): DrainLease | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DrainLease;
  } catch {
    return null;
  }
}

function isExpired(lease: DrainLease, now: number, ttlMs: number): boolean {
  return new Date(lease.heartbeatAt).getTime() + ttlMs < now;
}

function isLiveHolder(lease: DrainLease): boolean {
  if (lease.hostBootId !== hostBootId()) return false; // different boot — holder is gone
  try {
    process.kill(lease.workerPid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the drain lease atomically. Returns null when a live unexpired lease
 * is held — the caller reports drain-in-progress and exits 0. Expired or dead
 * leases are reclaimed; re-entry safety is the drain's idempotency contract.
 */
export function acquireLease(queueDir: string, ttlMs = LEASE_TTL_MS): LeaseHandle | null {
  mkdirSync(queueDir, { recursive: true });
  const leasePath = join(queueDir, "lease.json");
  const now = Date.now();

  const existing = readLease(leasePath);
  if (existing && !isExpired(existing, now, ttlMs) && isLiveHolder(existing)) {
    return null; // held by a live worker — never double-process
  }

  // Atomic take: write to a unique temp and rename — the rename is atomic on
  // POSIX, and concurrent racers converge on one winner's file. Losers detect
  // the loss by re-reading: the lease on disk names a different leaseId.
  const lease: DrainLease = {
    leaseId: randomBytes(8).toString("hex"),
    workerPid: process.pid,
    hostBootId: hostBootId(),
    acquiredAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  const tmp = join(queueDir, `.lease-${lease.leaseId}`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(lease, null, 2));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, leasePath);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort
    }
  }
  // Verify the win — a concurrent racer's rename may have landed after ours.
  const onDisk = readLease(leasePath);
  if (!onDisk || onDisk.leaseId !== lease.leaseId) return null;

  return {
    lease,
    heartbeat() {
      const current = readLease(leasePath);
      if (!current || current.leaseId !== lease.leaseId) return; // lost — heartbeating another's lease is worse than expiry
      const updated = { ...current, heartbeatAt: new Date().toISOString() };
      const htmp = join(queueDir, `.lease-hb-${lease.leaseId}`);
      const hfd = openSync(htmp, "w");
      try {
        writeSync(hfd, JSON.stringify(updated, null, 2));
      } finally {
        closeSync(hfd);
      }
      try {
        renameSync(htmp, leasePath);
      } catch {
        try {
          unlinkSync(htmp);
        } catch {
          // best effort
        }
      }
    },
    release() {
      const current = readLease(leasePath);
      if (current?.leaseId === lease.leaseId) {
        try {
          unlinkSync(leasePath);
        } catch {
          // already gone
        }
      }
    },
  };
}
