/*
<MODULE_CONTRACT>
<purpose>ADR stamp-lock dead-holder tests (RFC-1504, AC-7): a lock file
recording this host and a dead pid is broken and the stamp acquire succeeds;
a live pid keeps refusing; a live pid past the stale budget is broken by
age. Lock files are planted by hand under a tmpdir workspace.</purpose>
<non-goals>
  <item>No full stamp run — the criterion exercises the acquire path the
  handler itself calls.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1504: step 4 — ADR stamp-lock tests</item>
  <item>RFC-1504: review fixes — stale-age break coverage</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { acquireAdrLock } from "./implement-stamp.ts";
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
  const ws = await mkdtemp(join(tmpdir(), "adr-lock-"));
  dirs.push(ws);
  const lockDir = join(ws, ".adr-locks");
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, "adr-9999.lock");
  await writeFile(lockPath, JSON.stringify(payload));
  return { ws, lockPath };
}

describe("adr stamp lock dead-holder recovery (RFC-1504)", () => {
  it("a dead pid is broken — acquire succeeds (AC-7)", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: deadPid(),
      host: hostname(),
      at: new Date().toISOString(),
    });
    const { acquired } = await acquireAdrLock(ws, "ADR-9999");
    expect(acquired).toBe(true);
    const held = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(held.pid).toBe(process.pid);
    await rm(lockPath, { force: true });
  });

  it("a live pid still refuses", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: process.pid,
      host: hostname(),
      at: new Date().toISOString(),
    });
    const { acquired } = await acquireAdrLock(ws, "ADR-9999");
    expect(acquired).toBe(false);
    await rm(lockPath, { force: true });
  });

  it("a live pid past the stale budget is broken by age", async () => {
    const { ws, lockPath } = await workspaceWithLock({
      pid: process.pid,
      host: hostname(),
      at: new Date(Date.now() - STAMP_LOCK_STALE_MS - 60_000).toISOString(),
    });
    const stale: { reason?: string }[] = [];
    const { acquired } = await acquireAdrLock(ws, "ADR-9999", {
      onStale: (i) => stale.push(i),
    });
    expect(acquired).toBe(true);
    expect(stale[0]?.reason).toBe("stale-age");
    await rm(lockPath, { force: true });
  });
});
