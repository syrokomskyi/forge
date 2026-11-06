/*
<MODULE_CONTRACT>
<purpose>withFlowLock + holderIsDead tests (RFC-1504, AC-1..AC-4): a lock whose
pid does not exist on this host is broken without waiting; a live pid waits
to the age limit; a foreign host applies the age rule only; a foreign boot
id on this host is treated as dead. Uses injected now/sleep — no real waits.</purpose>
<non-goals>
  <item>No real repository — lock files live under os.tmpdir().</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1504: step 1 — dead-holder lock tests</item>
  <item>RFC-1504: review fixes — legacy acquiredAt fallback, atomic break claim, verified stamp release, onStale warnings</item>
  <item>RFC-1515: close rfc-1515 review findings — delete tolerated paths before worktree remove, prune vanished registrations, verified branch -D, shared held-lock render, gated e2e throw, journal toleratedState, edge tests</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { currentBootId, holderIsDead } from "../../core/lock-holder.ts";
import { describeHeldLock, withFlowLock, LockTimeoutError } from "../locks.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

const deadPid = (): number => {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (pid === undefined) throw new Error("spawn failed — cannot produce a dead pid");
  return pid;
};
const livePid = (): number => process.pid;
const HOST = hostname();

function fakeClock(start = 0) {
  let t = start;
  const sleep = async (ms: number): Promise<void> => {
    t += ms;
  };
  return { now: () => t, sleep, advance: (ms: number) => (t += ms) };
}

const io = { readFile: (p: string) => readFile(p, "utf8") };

async function lockDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flow-lock-"));
  dirs.push(dir);
  return dir;
}

interface StaleCall {
  path: string;
  at: string;
  ageMs: number;
  reason?: string;
  pid?: number;
  host?: string;
}

describe("holderIsDead (RFC-1504)", () => {
  it("dead pid on this host → dead (AC-1 basis)", () => {
    expect(holderIsDead({ pid: deadPid(), host: HOST })).toBe(true);
  });

  it("live pid on this host → alive", () => {
    expect(holderIsDead({ pid: livePid(), host: HOST })).toBe(false);
  });

  it("foreign host → never dead by pid (AC-3 basis)", () => {
    expect(holderIsDead({ pid: deadPid(), host: "other-host" })).toBe(false);
  });

  it("absent host → never dead by pid", () => {
    expect(holderIsDead({ pid: deadPid() })).toBe(false);
  });

  it("a pid we cannot signal (EPERM) counts as alive — fail closed", () => {
    // init (pid 1) on POSIX; the System process (pid 4) on Windows — each
    // survives or EPERMs a signal-0 on its own platform, never ESRCH.
    const unsignalablePid = process.platform === "win32" ? 4 : 1;
    expect(holderIsDead({ pid: unsignalablePid, host: HOST })).toBe(false);
  });

  it("different boot id on this host → dead even with a live pid (AC-4 basis)", () => {
    const boot = currentBootId();
    if (boot === undefined) return; // non-Linux — the boot rule cannot fire
    expect(holderIsDead({ pid: livePid(), host: HOST, bootId: "different-boot" })).toBe(true);
  });
});

describe("withFlowLock dead-holder recovery (RFC-1504)", () => {
  it("acquires a dead-holder lock without waiting (AC-1)", async () => {
    const dir = await lockDir();
    const lockPath = join(dir, "test.lock");
    const at = new Date().toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: deadPid(), host: HOST, at }));

    const stale: StaleCall[] = [];
    const clock = fakeClock();
    const result = await withFlowLock(
      lockPath,
      {
        waitMs: 60_000,
        staleMs: 3_600_000,
        onStale: (l) => stale.push(l as StaleCall),
        now: clock.now,
        sleep: clock.sleep,
      },
      async () => "held",
      io,
    );
    expect(result).toBe("held");
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toBe("dead-holder");
    expect(stale[0]?.pid).toBeGreaterThan(0);
    // Lock released after fn — file is gone.
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();
  });

  it("waits to the age limit behind a live pid (AC-2)", async () => {
    const dir = await lockDir();
    const lockPath = join(dir, "test.lock");
    const at = new Date().toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: livePid(), host: HOST, at }));

    const clock = fakeClock();
    const stale: StaleCall[] = [];
    await expect(
      withFlowLock(
        lockPath,
        {
          waitMs: 500,
          staleMs: 3_600_000,
          onStale: (l) => stale.push(l as StaleCall),
          now: clock.now,
          sleep: clock.sleep,
        },
        async () => "held",
        io,
      ),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(stale).toHaveLength(0);
    // The live lock file survives the refused wait.
    const held = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(held.pid).toBe(livePid());
  });

  it("a foreign host applies only the age rule (AC-3)", async () => {
    const dir = await lockDir();
    const lockPath = join(dir, "test.lock");
    const at = new Date().toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: deadPid(), host: "other-host", at }));

    const clock = fakeClock();
    const stale: StaleCall[] = [];
    await expect(
      withFlowLock(
        lockPath,
        {
          waitMs: 500,
          staleMs: 3_600_000,
          onStale: (l) => stale.push(l as StaleCall),
          now: clock.now,
          sleep: clock.sleep,
        },
        async () => "held",
        io,
      ),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(stale).toHaveLength(0); // dead pid on a foreign host is not broken
  });

  it("a different boot id on this host is broken without waiting (AC-4)", async () => {
    const boot = currentBootId();
    if (boot === undefined) return; // non-Linux platform — rule not applicable
    const dir = await lockDir();
    const lockPath = join(dir, "test.lock");
    const at = new Date().toISOString();
    await writeFile(
      lockPath,
      JSON.stringify({ pid: livePid(), host: HOST, at, bootId: "different-boot" }),
    );

    const stale: StaleCall[] = [];
    const result = await withFlowLock(
      lockPath,
      {
        waitMs: 500,
        staleMs: 3_600_000,
        onStale: (l) => stale.push(l as StaleCall),
      },
      async () => "held",
      io,
    );
    expect(result).toBe("held");
    expect(stale[0]?.reason).toBe("dead-holder");
  });

  it("writes bootId into fresh lock content when available", async () => {
    const boot = currentBootId();
    const dir = await lockDir();
    const lockPath = join(dir, "test.lock");
    let captured: { bootId?: string } | null = null;
    await withFlowLock(
      lockPath,
      { waitMs: 500, staleMs: 3_600_000 },
      async () => {
        captured = JSON.parse(await readFile(lockPath, "utf8")) as { bootId?: string };
      },
      io,
    );
    const content = captured as { bootId?: string } | null;
    if (boot === undefined) expect(content?.bootId).toBeUndefined();
    else expect(content?.bootId).toBe(boot);
  });
});

describe("describeHeldLock — RFC-1515 lock payload classification", () => {
  it("reports a live local holder with a numeric heldMs", () => {
    const at = new Date(Date.now() - 5_000).toISOString();
    const lock = describeHeldLock({ pid: livePid(), host: HOST, at }, 3_600_000);
    expect(lock.disposition).toBe("live");
    expect(lock.heldMs).toBeGreaterThanOrEqual(5_000);
    expect(lock.pid).toBe(process.pid);
    expect(lock.host).toBe(HOST);
    expect(lock.at).toBe(at);
  });

  it("reports a dead local pid as dead-holder even inside the stale budget", () => {
    const lock = describeHeldLock(
      { pid: deadPid(), host: HOST, at: new Date().toISOString() },
      3_600_000,
    );
    expect(lock.disposition).toBe("dead-holder");
  });

  it("reports a live holder beyond the stale budget as stale", () => {
    const at = new Date(Date.now() - 7_200_000).toISOString();
    const lock = describeHeldLock({ pid: livePid(), host: HOST, at }, 3_600_000);
    expect(lock.disposition).toBe("stale");
    expect(lock.heldMs).toBeGreaterThan(3_600_000);
  });

  it("degrades heldMs to null when the holder timestamp never parsed", () => {
    const lock = describeHeldLock({ pid: livePid(), host: HOST, at: "garbage" }, 3_600_000);
    expect(lock.heldMs).toBeNull();
    expect(lock.disposition).toBe("live");
  });
});
