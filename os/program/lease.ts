/*
<MODULE_CONTRACT>
<purpose>Untracked lease management for program packets. Lease files live
under .forge/program-leases/<program>/ and contain only the token hash.
Raw tokens are never persisted to disk.</purpose>
<non-goals>
  <item>Do not store raw lease tokens — only the SHA-256 hash.</item>
  <item>Do not import from @warpgogol/* — forge must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial lease management.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { programPacketLeaseSchema, type ProgramPacketLease } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Lease directory
// ---------------------------------------------------------------------------

export function leaseDir(workspaceRoot: string, program: string): string {
  return path.join(workspaceRoot, ".forge", "program-leases", program);
}

export function leasePath(workspaceRoot: string, program: string, packetId: string): string {
  return path.join(leaseDir(workspaceRoot, program), `${packetId}.json`);
}

// ---------------------------------------------------------------------------
// Token utilities
// ---------------------------------------------------------------------------

/**
 * Generate a random opaque lease token (32 bytes hex).
 */
export function generateLeaseToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Hash a lease token for storage. Only the hash is persisted.
 */
export function hashLeaseToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Lease CRUD (untracked files)
// ---------------------------------------------------------------------------

/**
 * Read a lease file. Returns null if no lease exists.
 */
export function readLease(
  workspaceRoot: string,
  program: string,
  packetId: string,
): ProgramPacketLease | null {
  const p = leasePath(workspaceRoot, program, packetId);
  if (!fs.existsSync(p)) return null;

  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const result = programPacketLeaseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`PROGRAM-PACKET-01: malformed lease at ${p}: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Write a lease file atomically.
 */
export function writeLease(
  workspaceRoot: string,
  program: string,
  lease: ProgramPacketLease,
): void {
  const dir = leaseDir(workspaceRoot, program);
  fs.mkdirSync(dir, { recursive: true });
  const p = leasePath(workspaceRoot, program, lease.packetId);
  const content = JSON.stringify(lease, null, 2) + "\n";
  fs.writeFileSync(p, content);
}

/**
 * Delete a lease file.
 */
export function deleteLease(workspaceRoot: string, program: string, packetId: string): void {
  const p = leasePath(workspaceRoot, program, packetId);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

/**
 * Check if any active lease exists for a program (any packet).
 */
export function findActiveLeases(
  workspaceRoot: string,
  program: string,
): Array<{ packetId: string; lease: ProgramPacketLease }> {
  const dir = leaseDir(workspaceRoot, program);
  if (!fs.existsSync(dir)) return [];

  const results: Array<{ packetId: string; lease: ProgramPacketLease }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const p = path.join(dir, entry.name);
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result = programPacketLeaseSchema.safeParse(parsed);
    if (result.success) {
      results.push({
        packetId: result.data.packetId,
        lease: result.data,
      });
    }
  }
  return results;
}

/**
 * Check if a lease is stale (heartbeat exceeded timeout).
 */
export function isLeaseStale(lease: ProgramPacketLease, now: Date = new Date()): boolean {
  const heartbeatMs = Date.parse(lease.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return true;
  const elapsed = now.getTime() - heartbeatMs;
  return elapsed > lease.timeoutSeconds * 1000;
}

/**
 * Update heartbeat timestamp on an existing lease.
 */
export function updateHeartbeat(
  workspaceRoot: string,
  program: string,
  packetId: string,
  now: Date = new Date(),
): ProgramPacketLease {
  const existing = readLease(workspaceRoot, program, packetId);
  if (!existing) {
    throw new Error(`PROGRAM-PACKET-05: no lease found for ${packetId}`);
  }
  const updated: ProgramPacketLease = {
    ...existing,
    heartbeatAt: now.toISOString(),
  };
  writeLease(workspaceRoot, program, updated);
  return updated;
}
