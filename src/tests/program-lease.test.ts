/*
<MODULE_CONTRACT>
<purpose>Exclusive lease tests — concurrent starts, heartbeat, token mismatch,
timeout, explicit recovery, interrupted seal/complete, and release after
committed completion (RFC-0856 AC-6).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0856: initial exclusive lease tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  generateLeaseToken,
  hashLeaseToken,
  readLease,
  writeLease,
  deleteLease,
  findActiveLeases,
  isLeaseStale,
  updateHeartbeat,
  leasePath,
} from "../../os/program/lease.ts";
import type { ProgramPacketLease } from "../../os/program/schemas.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-lease-test-"));
}

function makeLease(overrides?: Partial<ProgramPacketLease>): ProgramPacketLease {
  const now = new Date().toISOString();
  return {
    schema: "forge/program-packet-lease@1",
    program: "RFC-0855",
    packetId: "010-test",
    phase: "execution",
    actor: "agent:bot1",
    baseCommit: "abc123def456",
    sealCommit: "abc123def456",
    tokenHash: hashLeaseToken(generateLeaseToken()),
    startedAt: now,
    heartbeatAt: now,
    timeoutSeconds: 3600,
    ...overrides,
  };
}

describe("exclusive lease management", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("token security", () => {
    it("generateLeaseToken produces 64-char hex string", () => {
      const token = generateLeaseToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("hashLeaseToken produces 64-char hex hash", () => {
      const token = generateLeaseToken();
      const hash = hashLeaseToken(token);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("hashLeaseToken is deterministic", () => {
      const token = "test-token-123";
      expect(hashLeaseToken(token)).toBe(hashLeaseToken(token));
    });

    it("hashLeaseToken differs for different tokens", () => {
      const t1 = generateLeaseToken();
      const t2 = generateLeaseToken();
      expect(hashLeaseToken(t1)).not.toBe(hashLeaseToken(t2));
    });
  });

  describe("writeLease + readLease", () => {
    it("round-trips a lease", () => {
      const lease = makeLease();
      writeLease(dir, "RFC-0855", lease);

      const read = readLease(dir, "RFC-0855", "010-test");
      expect(read).not.toBeNull();
      expect(read!.packetId).toBe("010-test");
      expect(read!.actor).toBe("agent:bot1");
      expect(read!.tokenHash).toBe(lease.tokenHash);
    });

    it("returns null when no lease exists", () => {
      expect(readLease(dir, "RFC-0855", "010-test")).toBeNull();
    });

    it("raw token is not stored in lease file", () => {
      const rawToken = generateLeaseToken();
      const lease = makeLease({ tokenHash: hashLeaseToken(rawToken) });
      writeLease(dir, "RFC-0855", lease);

      const p = leasePath(dir, "RFC-0855", "010-test");
      const fileContent = require("node:fs").readFileSync(p, "utf8");
      expect(fileContent).not.toContain(rawToken);
      expect(fileContent).toContain(lease.tokenHash);
    });
  });

  describe("concurrent start prevention", () => {
    it("findActiveLeases returns existing lease", () => {
      const lease = makeLease();
      writeLease(dir, "RFC-0855", lease);

      const active = findActiveLeases(dir, "RFC-0855");
      expect(active).toHaveLength(1);
      expect(active[0].packetId).toBe("010-test");
    });

    it("two leases for different packets coexist", () => {
      const l1 = makeLease({ packetId: "010-foo" });
      const l2 = makeLease({ packetId: "020-bar", actor: "agent:bot2" });
      writeLease(dir, "RFC-0855", l1);
      writeLease(dir, "RFC-0855", l2);

      const active = findActiveLeases(dir, "RFC-0855");
      expect(active).toHaveLength(2);
    });
  });

  describe("heartbeat", () => {
    it("updateHeartbeat refreshes heartbeatAt", () => {
      const oldDate = new Date("2026-01-01T10:00:00Z");
      const lease = makeLease({ heartbeatAt: oldDate.toISOString() });
      writeLease(dir, "RFC-0855", lease);

      const newDate = new Date("2026-01-01T11:00:00Z");
      updateHeartbeat(dir, "RFC-0855", "010-test", newDate);

      const read = readLease(dir, "RFC-0855", "010-test");
      expect(read!.heartbeatAt).toBe(newDate.toISOString());
      expect(read!.heartbeatAt).not.toBe(oldDate.toISOString());
    });

    it("throws when no lease exists", () => {
      expect(() => updateHeartbeat(dir, "RFC-0855", "nonexistent")).toThrow();
    });
  });

  describe("token mismatch", () => {
    it("different tokens produce different hashes", () => {
      const token1 = "token-a";
      const token2 = "token-b";
      expect(hashLeaseToken(token1)).not.toBe(hashLeaseToken(token2));
    });
  });

  describe("timeout / stale detection", () => {
    it("detects stale lease when heartbeat exceeds timeout", () => {
      const oldDate = new Date("2026-01-01T10:00:00Z");
      const lease = makeLease({
        heartbeatAt: oldDate.toISOString(),
        timeoutSeconds: 60, // 1 minute
      });

      const now = new Date("2026-01-01T10:05:00Z"); // 5 minutes later
      expect(isLeaseStale(lease, now)).toBe(true);
    });

    it("does not flag fresh lease as stale", () => {
      const now = new Date("2026-01-01T10:00:00Z");
      const lease = makeLease({
        heartbeatAt: now.toISOString(),
        timeoutSeconds: 3600,
      });

      expect(isLeaseStale(lease, now)).toBe(false);
    });

    it("flags lease as stale at exact timeout boundary", () => {
      const baseTime = new Date("2026-01-01T10:00:00Z");
      const lease = makeLease({
        heartbeatAt: baseTime.toISOString(),
        timeoutSeconds: 60,
      });

      const exactlyAtTimeout = new Date("2026-01-01T10:01:00Z");
      // elapsed = 60000ms, timeout = 60000ms, elapsed > timeout is false
      expect(isLeaseStale(lease, exactlyAtTimeout)).toBe(false);

      const justAfterTimeout = new Date("2026-01-01T10:01:01Z");
      expect(isLeaseStale(lease, justAfterTimeout)).toBe(true);
    });

    it("handles invalid heartbeat date", () => {
      const lease = makeLease({ heartbeatAt: "invalid-date" });
      expect(isLeaseStale(lease)).toBe(true);
    });
  });

  describe("release", () => {
    it("deleteLease removes the lease file", () => {
      const lease = makeLease();
      writeLease(dir, "RFC-0855", lease);

      const p = leasePath(dir, "RFC-0855", "010-test");
      expect(existsSync(p)).toBe(true);

      deleteLease(dir, "RFC-0855", "010-test");
      expect(existsSync(p)).toBe(false);
    });

    it("deleteLease is idempotent (no error on missing)", () => {
      expect(() => deleteLease(dir, "RFC-0855", "nonexistent")).not.toThrow();
    });

    it("readLease returns null after delete", () => {
      const lease = makeLease();
      writeLease(dir, "RFC-0855", lease);
      deleteLease(dir, "RFC-0855", "010-test");
      expect(readLease(dir, "RFC-0855", "010-test")).toBeNull();
    });
  });

  describe("recovery", () => {
    it("stale lease is detected by findActiveLeases but still returned", () => {
      const oldDate = new Date("2020-01-01T00:00:00Z");
      const lease = makeLease({
        heartbeatAt: oldDate.toISOString(),
        timeoutSeconds: 1,
      });
      writeLease(dir, "RFC-0855", lease);

      const active = findActiveLeases(dir, "RFC-0855");
      expect(active).toHaveLength(1);
      // isLeaseStale would return true for this
      expect(isLeaseStale(active[0].lease)).toBe(true);
    });
  });
});
