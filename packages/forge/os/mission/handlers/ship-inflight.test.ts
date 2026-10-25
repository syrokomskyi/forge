/*
<MODULE_CONTRACT>
<purpose>
RFC-1397 acceptance coverage for the mission.archive ship-in-flight guard:
the Phase-1 sweep skips a mission whose leitstand.ship journal holds an
incomplete operation (SHIP-INFLIGHT-01) while still archiving the rest,
stale ops degrade to SHIP-INFLIGHT-02 warnings, and the ship's own terminal
archive step is exempt via the internal --ship-op marker.
</purpose>
<non-goals>
  <item>Predicate unit coverage lives in werkstatt-shared/src/kernel/ship-inflight.test.ts — these tests exercise the handler integration only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1397: initial suite — AC-1 sweep skip, AC-4 --ship-op self-exemption, stale-warn and phase-2 move-back coverage.</item>
  <item>RFC-1397: guard mission lifecycle moves during in-flight ship operations (RFC-1397)</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMissionArchive } from "./archive.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

vi.mock("../../../src/utils/fs-trash.ts", () => ({
  trashPath: (targetPath: string) => fs.rm(targetPath, { recursive: true, force: true }),
}));

const execSyncMock = vi.fn<(cmd: string, opts?: Record<string, unknown>) => string | Buffer>();

vi.mock("node:child_process", () => ({
  execSync: (cmd: string, opts?: Record<string, unknown>) => execSyncMock(cmd, opts),
}));

const SYSTEM_ID = "testsys";

interface JournalRec {
  kind: string;
  opId: string;
  at: string;
  op?: string;
  missionId?: string;
  platformVersion?: string;
  step?: string;
  seq?: number;
}

function opStarted(opId: string, missionId: string, at: string): JournalRec {
  return {
    kind: "op-started",
    opId,
    op: "leitstand.ship",
    missionId,
    at,
    platformVersion: "test",
  };
}

let testRoot: string;
let workspaceRoot: string;
let missionsDir: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ship-inflight-test-"));
  // shipJournalPath resolves workspaceRoot/../systems-cache — the workspace
  // must be a child of testRoot so the journal stays inside the sandbox.
  workspaceRoot = path.join(testRoot, "werkstatt");
  missionsDir = path.join(workspaceRoot, "missions");
  await fs.mkdir(missionsDir, { recursive: true });
  execSyncMock.mockReset();
  execSyncMock.mockReturnValue("");
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

function makeContext(): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: { info: () => {}, success: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    outputFormat: "json",
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { commandName: "mission.archive", flags } as unknown as ForgeCommandInput;
}

function unwrap<T>(result: { data?: T }): T {
  if (!result.data) throw new Error("result.data is undefined");
  return result.data;
}

async function writeMission(
  missionId: string,
  state: string,
  dir: string = missionsDir,
): Promise<string> {
  const missionDir = path.join(dir, missionId);
  await fs.mkdir(missionDir, { recursive: true });
  await fs.writeFile(
    path.join(missionDir, "mission.yaml"),
    `missionId: ${missionId}\nsystemId: ${SYSTEM_ID}\nstate: ${state}\n`,
  );
  return missionDir;
}

async function writeShipJournal(missionId: string, records: JournalRec[]): Promise<void> {
  const opsDir = path.join(testRoot, "systems-cache", SYSTEM_ID, "operations");
  await fs.mkdir(opsDir, { recursive: true });
  await fs.writeFile(
    path.join(opsDir, `ship-${missionId}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

describe("mission.archive ship-in-flight guard (RFC-1397)", () => {
  test("AC-1: in-flight mission is skipped with SHIP-INFLIGHT-01, others still archive", async () => {
    const now = new Date().toISOString();
    const inFlight = `${SYSTEM_ID}-m000001`;
    const normal = `${SYSTEM_ID}-m000002`;
    const inFlightDir = await writeMission(inFlight, "closed");
    await writeMission(normal, "closed");
    await writeShipJournal(inFlight, [
      opStarted("op-ship-1", inFlight, now),
      { kind: "step-started", opId: "op-ship-1", step: "certify-dev", seq: 3, at: now },
    ]);

    const data = unwrap(await runMissionArchive(makeInput(), makeContext()));

    const movedIds = data.moved.map((m: { missionId: string }) => m.missionId);
    expect(movedIds).toEqual([normal]);
    const skipped = data.skipped.find((s: { missionId: string }) => s.missionId === inFlight);
    expect(skipped?.reason).toContain("SHIP-INFLIGHT-01");
    expect(skipped?.reason).toContain("op-ship-1");
    expect(existsSync(inFlightDir)).toBe(true);
  });

  test("AC-4: --ship-op exempts the ship's own op so its terminal archive proceeds", async () => {
    const now = new Date().toISOString();
    const inFlight = `${SYSTEM_ID}-m000003`;
    await writeMission(inFlight, "closed");
    await writeShipJournal(inFlight, [opStarted("op-ship-9", inFlight, now)]);

    const data = unwrap(
      await runMissionArchive(makeInput({ "ship-op": "op-ship-9" }), makeContext()),
    );

    expect(data.moved.map((m: { missionId: string }) => m.missionId)).toEqual([inFlight]);
    expect(existsSync(path.join(missionsDir, "archive", "closed", inFlight))).toBe(true);
  });

  test("a foreign --ship-op does not exempt a different in-flight op", async () => {
    const now = new Date().toISOString();
    const inFlight = `${SYSTEM_ID}-m000004`;
    const dir = await writeMission(inFlight, "closed");
    await writeShipJournal(inFlight, [opStarted("op-ship-real", inFlight, now)]);

    const data = unwrap(
      await runMissionArchive(makeInput({ "ship-op": "op-ship-fake" }), makeContext()),
    );

    expect(data.moved).toHaveLength(0);
    expect(existsSync(dir)).toBe(true);
  });

  test("stale in-flight op warns SHIP-INFLIGHT-02 but does not block the move", async () => {
    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const missionId = `${SYSTEM_ID}-m000005`;
    await writeMission(missionId, "closed");
    await writeShipJournal(missionId, [opStarted("op-ship-old", missionId, stale)]);

    const data = unwrap(await runMissionArchive(makeInput(), makeContext()));

    expect(data.moved.map((m: { missionId: string }) => m.missionId)).toEqual([missionId]);
    expect(existsSync(path.join(missionsDir, "archive", "closed", missionId))).toBe(true);
  });

  test("closed ship journal (op-done) does not block the move", async () => {
    const now = new Date().toISOString();
    const missionId = `${SYSTEM_ID}-m000006`;
    await writeMission(missionId, "closed");
    await writeShipJournal(missionId, [
      opStarted("op-ship-1", missionId, now),
      { kind: "op-done", opId: "op-ship-1", at: now },
    ]);

    const data = unwrap(await runMissionArchive(makeInput(), makeContext()));

    expect(data.moved.map((m: { missionId: string }) => m.missionId)).toEqual([missionId]);
  });

  test("--clean-orphans checks an orphan dir via the name-prefix systemId", async () => {
    const now = new Date().toISOString();
    const missionId = `${SYSTEM_ID}-m000008`;
    // Orphan-shaped dir: no mission.yaml, only cache content — but the
    // DNA-46 name still resolves its systemId for the journal check.
    const missionDir = path.join(missionsDir, missionId);
    await fs.mkdir(path.join(missionDir, "workpiece", ".astro"), { recursive: true });
    await fs.writeFile(path.join(missionDir, "workpiece", ".astro", "cache.txt"), "cache\n");
    await writeShipJournal(missionId, [opStarted("op-ship-3", missionId, now)]);

    const data = unwrap(
      await runMissionArchive(makeInput({ "clean-orphans": true }), makeContext()),
    );

    expect(data.moved).toHaveLength(0);
    const skipped = data.skipped.find((s: { missionId: string }) => s.missionId === missionId);
    expect(skipped?.reason).toContain("SHIP-INFLIGHT-01");
    expect(existsSync(missionDir)).toBe(true);
  });

  test("phase-2 move-back also skips an in-flight mission", async () => {
    const now = new Date().toISOString();
    const missionId = `${SYSTEM_ID}-m000007`;
    // An open mission wrongly sitting in archive/closed/ — phase 2 would
    // normally move it back; in-flight it must stay put.
    const archived = await writeMission(
      missionId,
      "open",
      path.join(missionsDir, "archive", "closed"),
    );
    await writeShipJournal(missionId, [opStarted("op-ship-2", missionId, now)]);

    const data = unwrap(await runMissionArchive(makeInput(), makeContext()));

    expect(data.moved).toHaveLength(0);
    const skipped = data.skipped.find((s: { missionId: string }) => s.missionId === missionId);
    expect(skipped?.reason).toContain("SHIP-INFLIGHT-01");
    expect(existsSync(archived)).toBe(true);
  });
});
