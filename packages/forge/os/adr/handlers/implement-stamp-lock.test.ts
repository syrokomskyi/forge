/*
<MODULE_CONTRACT>
<purpose>ADR stamp-lock dead-holder tests (RFC-1504, AC-7): a lock file
recording this host and a dead pid is broken and the stamp acquire succeeds;
a live pid keeps refusing. Lock files are planted by hand under a tmpdir
workspace.</purpose>
<non-goals>
  <item>No full stamp run — the criterion exercises the acquire path the
  handler itself calls.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1504: step 4 — ADR stamp-lock tests</item>
  <item>RFC-1504: step 1 — dead-holder lock tests</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { acquireAdrLock } from "./implement-stamp.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;

async function workspaceWithLock(pid: number, host = hostname()): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "adr-lock-"));
  dirs.push(ws);
  const lockDir = join(ws, ".adr-locks");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    join(lockDir, "adr-9999.lock"),
    JSON.stringify({ pid, host, at: new Date().toISOString() }),
  );
  return ws;
}

describe("adr stamp lock dead-holder recovery (RFC-1504)", () => {
  it("a dead pid is broken — acquire succeeds (AC-7)", async () => {
    const ws = await workspaceWithLock(deadPid());
    const { acquired, lockPath } = await acquireAdrLock(ws, "ADR-9999");
    expect(acquired).toBe(true);
    const held = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(held.pid).toBe(process.pid);
    await rm(lockPath, { force: true });
  });

  it("a live pid still refuses", async () => {
    const ws = await workspaceWithLock(process.pid);
    const { acquired, lockPath } = await acquireAdrLock(ws, "ADR-9999");
    expect(acquired).toBe(false);
    await rm(lockPath, { force: true });
  });
});
