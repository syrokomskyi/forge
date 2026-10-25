/*
<MODULE_CONTRACT>
<purpose>
RFC-1397 standalone-degradation coverage: when
@warpgogol/werkstatt-shared/kernel/ship-inflight cannot be imported — the
situation on a standalone forge install, where the package is only a
workspace devDependency — the ship-in-flight guard degrades to warn-once +
proceed instead of breaking mission.archive at module load.
</purpose>
<non-goals>
  <item>Full guard coverage lives in ship-inflight.test.ts — this file only exercises the unavailable-module path and needs its own vi.mock.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1397: initial suite — lazy-bridge import failure warns and the sweep proceeds.</item>
  <item>RFC-1397: harden ship-in-flight guard per independent review (RFC-1397)</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("@warpgogol/werkstatt-shared/kernel/ship-inflight", () => {
  throw new Error("Cannot find module '@warpgogol/werkstatt-shared/kernel/ship-inflight'");
});

vi.mock("../../../src/utils/fs-trash.ts", () => ({
  trashPath: (targetPath: string) => fs.rm(targetPath, { recursive: true, force: true }),
}));

const execSyncMock = vi.fn<(cmd: string, opts?: Record<string, unknown>) => string | Buffer>();

vi.mock("node:child_process", () => ({
  execSync: (cmd: string, opts?: Record<string, unknown>) => execSyncMock(cmd, opts),
}));

import { runMissionArchive } from "./archive.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

let testRoot: string;
let workspaceRoot: string;
let missionsDir: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ship-inflight-degraded-"));
  workspaceRoot = path.join(testRoot, "werkstatt");
  missionsDir = path.join(workspaceRoot, "missions");
  await fs.mkdir(missionsDir, { recursive: true });
  execSyncMock.mockReset();
  execSyncMock.mockReturnValue("");
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

function makeContext(warn: (m: string) => void): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: { info: () => {}, success: () => {}, warn, error: () => {}, debug: () => {} },
    outputFormat: "json",
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { commandName: "mission.archive", flags } as unknown as ForgeCommandInput;
}

describe("mission.archive ship-in-flight degradation (RFC-1397)", () => {
  test("missing werkstatt-shared warns once and the sweep proceeds", async () => {
    const missionId = "testsys-m000001";
    const missionDir = path.join(missionsDir, missionId);
    await fs.mkdir(missionDir, { recursive: true });
    await fs.writeFile(
      path.join(missionDir, "mission.yaml"),
      `missionId: ${missionId}\nsystemId: testsys\nstate: closed\n`,
    );
    // An in-flight journal exists but cannot be consulted — the guard is
    // vacuous where the predicate module itself is absent.
    const opsDir = path.join(testRoot, "systems-cache", "testsys", "operations");
    await fs.mkdir(opsDir, { recursive: true });
    await fs.writeFile(
      path.join(opsDir, `ship-${missionId}.jsonl`),
      JSON.stringify({
        kind: "op-started",
        opId: "op-ship-1",
        op: "leitstand.ship",
        missionId,
        at: new Date().toISOString(),
      }) + "\n",
    );

    const warn = vi.fn();
    const result = await runMissionArchive(makeInput(), makeContext(warn));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ship-inflight guard unavailable"));
    const movedIds = (result.data?.moved ?? []).map((m: { missionId: string }) => m.missionId);
    expect(movedIds).toContain(missionId);
    expect(existsSync(path.join(missionsDir, "archive", "closed", missionId))).toBe(true);
  });
});
