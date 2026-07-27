/*
<MODULE_CONTRACT>
<purpose>Werkstatt lock helpers. Moved from @warpgogol/site-kernel-handoff to
@webgogol/forge for full autonomous mode (RFC-0556). Provides acquire, release,
heartbeat, status, and stale-lock removal.</purpose>
<non-goals>
  <item>Do not implement distributed locks — local process-level only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0362: initial lock helpers (acquire, release, heartbeat, status).</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-handoff to @webgogol/forge for autonomous mode.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { werkstattLockSchema, type WerkstattLock } from "./schema.ts";

const LOCKS_DIR = path.join(".werkstatt", "locks");
const DEFAULT_TIMEOUT_SECONDS = 900;

function resolveLocksDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, LOCKS_DIR);
}

function resolveLockPath(workspaceRoot: string, scope: string): string {
  const safeScope = scope.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return path.join(resolveLocksDir(workspaceRoot), `${safeScope}.lock.json`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isLockStale(lock: WerkstattLock, now: Date = new Date()): boolean {
  if (!isProcessAlive(lock.pid)) return true;
  const heartbeatAge = (now.getTime() - new Date(lock.heartbeatAt).getTime()) / 1000;
  return heartbeatAge >= lock.timeoutSeconds;
}

export async function acquireLock(
  workspaceRoot: string,
  scope: string,
  operationId: string,
  command: string,
  owner: string,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS,
): Promise<WerkstattLock> {
  const lockPath = resolveLockPath(workspaceRoot, scope);
  const locksDir = resolveLocksDir(workspaceRoot);

  if (!existsSync(locksDir)) {
    await fs.mkdir(locksDir, { recursive: true });
  }

  if (existsSync(lockPath)) {
    const raw = await fs.readFile(lockPath, "utf8");
    try {
      const existing = werkstattLockSchema.parse(JSON.parse(raw));
      if (!isLockStale(existing)) {
        throw new Error(
          `[werkstatt.lock] lock '${scope}' held by operation '${existing.operationId}' (pid: ${existing.pid})`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("held by")) throw err;
    }
  }

  const now = new Date().toISOString();
  const lock: WerkstattLock = {
    schemaVersion: "1.0.0",
    scope,
    operationId,
    command,
    owner,
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    timeoutSeconds,
  };

  werkstattLockSchema.parse(lock);
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
  return lock;
}

export async function releaseLock(workspaceRoot: string, scope: string): Promise<void> {
  const lockPath = resolveLockPath(workspaceRoot, scope);
  try {
    await fs.unlink(lockPath);
  } catch {
    // already gone
  }
}

export async function heartbeatLock(workspaceRoot: string, scope: string): Promise<void> {
  const lockPath = resolveLockPath(workspaceRoot, scope);
  if (!existsSync(lockPath)) return;
  const raw = await fs.readFile(lockPath, "utf8");
  const lock = werkstattLockSchema.parse(JSON.parse(raw));
  lock.heartbeatAt = new Date().toISOString();
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

export async function readAllLocks(
  workspaceRoot: string,
): Promise<Array<WerkstattLock & { stale: boolean }>> {
  const locksDir = resolveLocksDir(workspaceRoot);
  if (!existsSync(locksDir)) return [];

  const files = await fs.readdir(locksDir);
  const locks: Array<WerkstattLock & { stale: boolean }> = [];

  for (const file of files) {
    if (!file.endsWith(".lock.json")) continue;
    const raw = await fs.readFile(path.join(locksDir, file), "utf8");
    try {
      const lock = werkstattLockSchema.parse(JSON.parse(raw));
      locks.push({ ...lock, stale: isLockStale(lock) });
    } catch {
      // skip corrupt lock files
    }
  }

  return locks;
}

export async function removeStaleLock(workspaceRoot: string, scope: string): Promise<boolean> {
  const lockPath = resolveLockPath(workspaceRoot, scope);
  if (!existsSync(lockPath)) return false;
  const raw = await fs.readFile(lockPath, "utf8");
  const lock = werkstattLockSchema.parse(JSON.parse(raw));
  if (!isLockStale(lock)) return false;
  await fs.unlink(lockPath);
  return true;
}
