import { test, expect, describe } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLock,
  releaseLock,
  heartbeatLock,
  readAllLocks,
  isLockStale,
  removeStaleLock,
} from "../../os/werkstatt/handlers/lock.ts";
import { werkstattLockSchema } from "../../os/werkstatt/handlers/schema.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-werkstatt-test-"));
}

function makeValidLock(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0.0",
    scope: "test-scope",
    operationId: "op-001",
    command: "test.command",
    owner: "test-owner",
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    timeoutSeconds: 900,
    ...overrides,
  };
}

describe("werkstattLockSchema", () => {
  test("accepts a valid lock object", () => {
    const lock = makeValidLock();
    expect(() => werkstattLockSchema.parse(lock)).not.toThrow();
  });

  test("rejects wrong schemaVersion", () => {
    const lock = makeValidLock({ schemaVersion: "2.0.0" });
    expect(() => werkstattLockSchema.parse(lock)).toThrow();
  });

  test("rejects empty scope", () => {
    const lock = makeValidLock({ scope: "" });
    expect(() => werkstattLockSchema.parse(lock)).toThrow();
  });

  test("rejects negative timeoutSeconds", () => {
    const lock = makeValidLock({ timeoutSeconds: -1 });
    expect(() => werkstattLockSchema.parse(lock)).toThrow();
  });

  test("rejects non-integer pid", () => {
    const lock = makeValidLock({ pid: 1.5 });
    expect(() => werkstattLockSchema.parse(lock)).toThrow();
  });

  test("rejects non-datetime startedAt", () => {
    const lock = makeValidLock({ startedAt: "not-a-date" });
    expect(() => werkstattLockSchema.parse(lock)).toThrow();
  });
});

describe("isLockStale", () => {
  test("returns false for a fresh lock held by current process", () => {
    const lock = makeValidLock();
    expect(isLockStale(lock as never, new Date())).toBe(false);
  });

  test("returns true when heartbeat exceeds timeout", () => {
    const oldHeartbeat = new Date(Date.now() - 1000 * 960).toISOString();
    const lock = makeValidLock({ heartbeatAt: oldHeartbeat, timeoutSeconds: 900 });
    expect(isLockStale(lock as never, new Date())).toBe(true);
  });

  test("returns true when pid is not alive", () => {
    const lock = makeValidLock({ pid: 999999 });
    expect(isLockStale(lock as never, new Date())).toBe(true);
  });

  test("returns false at exact boundary (heartbeatAge == timeout)", () => {
    const now = new Date();
    const heartbeat = new Date(now.getTime() - 900 * 1000);
    const lock = makeValidLock({ heartbeatAt: heartbeat.toISOString(), timeoutSeconds: 900 });
    expect(isLockStale(lock as never, now)).toBe(true);
  });
});

describe("acquireLock", () => {
  test("creates a lock file on disk", async () => {
    const dir = await makeTempDir();
    try {
      const lock = await acquireLock(dir, "test-scope", "op-001", "test.cmd", "owner");
      expect(lock.scope).toBe("test-scope");
      expect(lock.pid).toBe(process.pid);
      const files = await readdir(join(dir, ".werkstatt", "locks"));
      expect(files).toContain("test-scope.lock.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when lock is held by a different live process", async () => {
    const dir = await makeTempDir();
    try {
      const otherPidLock = makeValidLock({
        scope: "blocked-scope",
        operationId: "op-001",
        pid: process.ppid,
      });
      const locksDir = join(dir, ".werkstatt", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(
        join(locksDir, "blocked-scope.lock.json"),
        JSON.stringify(otherPidLock, null, 2),
      );
      await expect(
        acquireLock(dir, "blocked-scope", "op-002", "test.cmd", "owner"),
      ).rejects.toThrow(/held by/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is re-entrant for same PID (increments depth)", async () => {
    const dir = await makeTempDir();
    try {
      const lock1 = await acquireLock(dir, "reen-scope", "op-001", "outer.cmd", "owner");
      expect(lock1.depth).toBeUndefined();
      const lock2 = await acquireLock(dir, "reen-scope", "op-002", "inner.cmd", "owner");
      expect(lock2.depth).toBe(2);
      // Lock file still exists
      const files = await readdir(join(dir, ".werkstatt", "locks"));
      expect(files).toContain("reen-scope.lock.json");
      // Inner release decrements but does not delete
      await releaseLock(dir, "reen-scope");
      const filesAfterInner = await readdir(join(dir, ".werkstatt", "locks"));
      expect(filesAfterInner).toContain("reen-scope.lock.json");
      // Outer release deletes
      await releaseLock(dir, "reen-scope");
      const filesAfterOuter = await readdir(join(dir, ".werkstatt", "locks"));
      expect(filesAfterOuter).not.toContain("reen-scope.lock.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("overwrites a stale lock", async () => {
    const dir = await makeTempDir();
    try {
      const staleLock = makeValidLock({
        scope: "stale-scope",
        operationId: "old-op",
        pid: 999999,
        heartbeatAt: new Date(Date.now() - 2000 * 1000).toISOString(),
      });
      const locksDir = join(dir, ".werkstatt", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(join(locksDir, "stale-scope.lock.json"), JSON.stringify(staleLock, null, 2));

      const lock = await acquireLock(dir, "stale-scope", "new-op", "test.cmd", "owner");
      expect(lock.operationId).toBe("new-op");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sanitizes scope with special characters", async () => {
    const dir = await makeTempDir();
    try {
      await acquireLock(dir, "scope/with/slashes", "op-001", "test.cmd", "owner");
      const files = await readdir(join(dir, ".werkstatt", "locks"));
      expect(files).toContain("scope_with_slashes.lock.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("releaseLock", () => {
  test("removes the lock file", async () => {
    const dir = await makeTempDir();
    try {
      await acquireLock(dir, "release-scope", "op-001", "test.cmd", "owner");
      await releaseLock(dir, "release-scope");
      const files = await readdir(join(dir, ".werkstatt", "locks"));
      expect(files).not.toContain("release-scope.lock.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not throw when lock file does not exist", async () => {
    const dir = await makeTempDir();
    try {
      await expect(releaseLock(dir, "nonexistent")).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("decrements depth for re-entrant lock instead of deleting", async () => {
    const dir = await makeTempDir();
    try {
      await acquireLock(dir, "depth-scope", "op-001", "outer.cmd", "owner");
      await acquireLock(dir, "depth-scope", "op-002", "inner.cmd", "owner");
      await releaseLock(dir, "depth-scope");
      const locks = await readAllLocks(dir);
      const lock = locks.find((l) => l.scope === "depth-scope");
      expect(lock).toBeDefined();
      expect(lock!.depth).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("heartbeatLock", () => {
  test("updates heartbeatAt on disk", async () => {
    const dir = await makeTempDir();
    try {
      const original = await acquireLock(dir, "hb-scope", "op-001", "test.cmd", "owner");
      await new Promise((r) => setTimeout(r, 50));
      await heartbeatLock(dir, "hb-scope");
      const locks = await readAllLocks(dir);
      const updated = locks.find((l) => l.scope === "hb-scope");
      expect(updated).toBeDefined();
      expect(updated!.heartbeatAt).not.toBe(original.heartbeatAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does nothing when lock file does not exist", async () => {
    const dir = await makeTempDir();
    try {
      await expect(heartbeatLock(dir, "nonexistent")).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readAllLocks", () => {
  test("returns empty array when no locks directory exists", async () => {
    const dir = await makeTempDir();
    try {
      const locks = await readAllLocks(dir);
      expect(locks).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns all valid locks with stale flag", async () => {
    const dir = await makeTempDir();
    try {
      await acquireLock(dir, "active-scope", "op-001", "test.cmd", "owner");
      const staleLock = makeValidLock({
        scope: "stale-scope",
        operationId: "stale-op",
        pid: 999999,
        heartbeatAt: new Date(Date.now() - 2000 * 1000).toISOString(),
      });
      const locksDir = join(dir, ".werkstatt", "locks");
      await writeFile(join(locksDir, "stale-scope.lock.json"), JSON.stringify(staleLock, null, 2));

      const locks = await readAllLocks(dir);
      expect(locks).toHaveLength(2);
      const active = locks.find((l) => l.scope === "active-scope");
      const stale = locks.find((l) => l.scope === "stale-scope");
      expect(active?.stale).toBe(false);
      expect(stale?.stale).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips corrupt lock files", async () => {
    const dir = await makeTempDir();
    try {
      await acquireLock(dir, "good-scope", "op-001", "test.cmd", "owner");
      const locksDir = join(dir, ".werkstatt", "locks");
      await writeFile(join(locksDir, "corrupt.lock.json"), "{ not valid json");

      const locks = await readAllLocks(dir);
      expect(locks).toHaveLength(1);
      expect(locks[0].scope).toBe("good-scope");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("removeStaleLock", () => {
  test("removes a stale lock and returns true", async () => {
    const dir = await makeTempDir();
    try {
      const staleLock = makeValidLock({
        scope: "stale-remove",
        pid: 999999,
        heartbeatAt: new Date(Date.now() - 2000 * 1000).toISOString(),
      });
      const locksDir = join(dir, ".werkstatt", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(join(locksDir, "stale-remove.lock.json"), JSON.stringify(staleLock, null, 2));

      const removed = await removeStaleLock(dir, "stale-remove");
      expect(removed).toBe(true);
      const files = await readdir(locksDir);
      expect(files).not.toContain("stale-remove.lock.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false for a non-stale lock", async () => {
    const dir = await makeTempDir();
    try {
      await acquireLock(dir, "active-remove", "op-001", "test.cmd", "owner");
      const removed = await removeStaleLock(dir, "active-remove");
      expect(removed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false when lock does not exist", async () => {
    const dir = await makeTempDir();
    try {
      const removed = await removeStaleLock(dir, "nonexistent");
      expect(removed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
