import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMissionArchive } from "./archive.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      info: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    outputFormat: "json",
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return {
    commandName: "mission.archive",
    flags,
  } as unknown as ForgeCommandInput;
}

function unwrap<T>(result: { data?: T }): T {
  if (!result.data) throw new Error("result.data is undefined");
  return result.data;
}

async function writeMissionManifest(
  missionsDir: string,
  missionId: string,
  state: string,
): Promise<void> {
  const missionDir = path.join(missionsDir, missionId);
  await fs.mkdir(missionDir, { recursive: true });
  await fs.writeFile(
    path.join(missionDir, "mission.yaml"),
    `missionId: ${missionId}\nstate: ${state}\n`,
  );
}

let tmpDir: string;
let missionsDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mission-archive-test-"));
  missionsDir = path.join(tmpDir, "missions");
  await fs.mkdir(missionsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("mission.archive", () => {
  test("terminal mission (closed) → moved to archive/closed/", async () => {
    await writeMissionManifest(missionsDir, "test-m001", "closed");

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-m001");
    expect(data.moved[0].state).toBe("closed");
    expect(data.moved[0].direction).toBe("into-archive");
    expect(existsSync(path.join(missionsDir, "test-m001"))).toBe(false);
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-m001"))).toBe(true);
  });

  test("terminal mission (aborted) → moved to archive/aborted/", async () => {
    await writeMissionManifest(missionsDir, "test-m002", "aborted");

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-m002");
    expect(data.moved[0].state).toBe("aborted");
    expect(existsSync(path.join(missionsDir, "archive", "aborted", "test-m002"))).toBe(true);
  });

  test("open mission → skipped (non-terminal)", async () => {
    await writeMissionManifest(missionsDir, "test-m003", "open");

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(0);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0].reason).toContain("non-terminal");
    expect(existsSync(path.join(missionsDir, "test-m003"))).toBe(true);
  });

  test("--status closed filter → only closed missions moved", async () => {
    await writeMissionManifest(missionsDir, "test-m004", "closed");
    await writeMissionManifest(missionsDir, "test-m005", "aborted");

    const data = unwrap(
      await runMissionArchive(makeInput({ status: "closed" }), makeContext(tmpDir)),
    );

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-m004");
    expect(existsSync(path.join(missionsDir, "test-m005"))).toBe(true);
  });

  test("--dry-run → reports moves without touching filesystem", async () => {
    await writeMissionManifest(missionsDir, "test-m006", "closed");

    const data = unwrap(
      await runMissionArchive(makeInput({ "dry-run": true }), makeContext(tmpDir)),
    );

    expect(data.moved).toHaveLength(1);
    expect(data.dryRun).toBe(true);
    expect(existsSync(path.join(missionsDir, "test-m006"))).toBe(true);
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-m006"))).toBe(false);
  });

  test("destination exists → skipped with 'destination exists' reason", async () => {
    await writeMissionManifest(missionsDir, "test-m007", "closed");
    const archiveDir = path.join(missionsDir, "archive", "closed", "test-m007");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, "mission.yaml"),
      "missionId: test-m007\nstate: closed\n",
    );

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(0);
    expect(data.skipped).toHaveLength(2);
    expect(data.skipped.some((s) => s.reason === "destination exists")).toBe(true);
  });

  test("unreadable manifest → skipped with 'unreadable manifest' reason", async () => {
    const missionDir = path.join(missionsDir, "test-m008");
    await fs.mkdir(missionDir, { recursive: true });
    // No mission.yaml — unreadable

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(0);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0].reason).toBe("unreadable manifest");
  });

  test("open mission in archive/ → moved back to missions/ (bidirectional)", async () => {
    await writeMissionManifest(missionsDir, "test-m009", "open");
    const archiveMissionDir = path.join(missionsDir, "archive", "closed", "test-m010");
    await fs.mkdir(archiveMissionDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveMissionDir, "mission.yaml"),
      "missionId: test-m010\nstate: open\n",
    );

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    const outOfArchive = data.moved.filter((m) => m.direction === "out-of-archive");
    expect(outOfArchive).toHaveLength(1);
    expect(outOfArchive[0].missionId).toBe("test-m010");
    expect(existsSync(path.join(missionsDir, "test-m010"))).toBe(true);
    expect(existsSync(archiveMissionDir)).toBe(false);
  });

  test("invalid --status value → throws error", async () => {
    await expect(
      runMissionArchive(makeInput({ status: "invalid" }), makeContext(tmpDir)),
    ).rejects.toThrow('Invalid --status "invalid"');
  });

  test("no missions/ directory → empty result", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "mission-archive-empty-"));
    try {
      const data = unwrap(await runMissionArchive(makeInput(), makeContext(emptyDir)));
      expect(data.moved).toHaveLength(0);
      expect(data.skipped).toHaveLength(0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});
