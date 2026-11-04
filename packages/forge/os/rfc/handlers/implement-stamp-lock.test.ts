/*
<MODULE_CONTRACT>
<purpose>RFC stamp-lock dead-holder tests (RFC-1504, AC-5, AC-6): a lock file
recording this host and a dead pid is broken and the stamp acquire succeeds;
a live pid keeps refusing with acquired:false (the RFC-IMP-05 path). Lock
files are planted by hand under a tmpdir workspace.</purpose>
<non-goals>
  <item>No full stamp run — the criterion exercises the acquire path the
  handler itself calls.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1504: step 4 — RFC stamp-lock tests</item>
  <item>RFC-1504: step 1 — dead-holder lock tests</item>
  <item>RFC-1504: review fixes — legacy acquiredAt fallback, atomic break claim, verified stamp release, onStale warnings</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { acquireRfcLock } from "./implement-stamp.ts";
import { STAMP_LOCK_STALE_MS } from "../../core/stamp-lock.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

const deadPid = (): number => {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (pid === undefined) throw new Error("spawn failed — cannot produce a dead pid");
  return pid;
};

async function workspaceWithLock(
  payload: Record<string, unknown>,
): Promise<{ ws: string; lockPath: string }> {
  const ws = await mkdtemp(join(tmpdir(), "rfc-lock-"));
  dirs.push(ws);
  const lockDir = join(ws, ".rfc-locks");
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, "rfc-9999.lock");
  await writeFile(lockPath, JSON.stringify(payload));
  return { ws, lockPath };
}

const freshAt = () => new Date().toISOString();
const oldAt = () => new Date(Date.now() - STAMP_LOCK_STALE_MS - 60_000).toISOString();

describe("rfc stamp lock dead-holder recovery (RFC-1504)", () => {
  it("a dead pid is broken — acquire succeeds (AC-5)", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: deadPid(),
      host: hostname(),
      at: freshAt(),
    });
    const { acquired } = await acquireRfcLock(ws, "RFC-9999");
    expect(acquired).toBe(true);
    // The new holder's content is ours, not the dead pid's.
    const held = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; host: string };
    expect(held.pid).toBe(process.pid);
    await rm(lockPath, { force: true });
  });

  it("a live pid still refuses — the RFC-IMP-05 path (AC-6)", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: process.pid,
      host: hostname(),
      at: freshAt(),
    });
    const { acquired } = await acquireRfcLock(ws, "RFC-9999");
    expect(acquired).toBe(false);
    const held = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(held.pid).toBe(process.pid);
    await rm(lockPath, { force: true });
  });

  it("a foreign host is not broken by pid", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: deadPid(),
      host: "other-host",
      at: freshAt(),
    });
    const { acquired } = await acquireRfcLock(ws, "RFC-9999");
    expect(acquired).toBe(false);
    await rm(lockPath, { force: true });
  });

  it("legacy {pid, acquiredAt} locks are judged by age — an old one is broken", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: deadPid(),
      acquiredAt: oldAt(),
    });
    const stale: { reason?: string }[] = [];
    const { acquired } = await acquireRfcLock(ws, "RFC-9999", {
      onStale: (i) => stale.push(i),
    });
    expect(acquired).toBe(true);
    expect(stale[0]?.reason).toBe("stale-age");
    await rm(lockPath, { force: true });
  });

  it("a fresh legacy {pid, acquiredAt} lock is refused — age under the limit", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: deadPid(),
      acquiredAt: freshAt(),
    });
    const { acquired } = await acquireRfcLock(ws, "RFC-9999");
    expect(acquired).toBe(false);
    await rm(lockPath, { force: true });
  });

  it("a live pid past the stale budget is broken with reason stale-age", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: process.pid,
      host: hostname(),
      at: oldAt(),
    });
    const stale: { reason?: string; pid?: number }[] = [];
    const { acquired } = await acquireRfcLock(ws, "RFC-9999", {
      onStale: (i) => stale.push(i),
    });
    expect(acquired).toBe(true);
    expect(stale[0]?.reason).toBe("stale-age");
    expect(stale[0]?.pid).toBe(process.pid);
    await rm(lockPath, { force: true });
  });
});
