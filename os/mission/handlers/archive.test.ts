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

  test("resurrected source path (e.g. .astro/ cache) → cleaned up after rename", async () => {
    await writeMissionManifest(missionsDir, "test-m011", "closed");
    const missionDir = path.join(missionsDir, "test-m011");

    // Simulate a watcher recreating a stale cache dir after rename by
    // monkey-patching fs.rename to re-create .astro/ at the source.
    const originalRename = fs.rename;
    const astroCacheDir = path.join(missionDir, "workpiece", ".astro");
    vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
      await originalRename(src, dest);
      // Simulate IDE/watcher recreating stale cache at old path
      await fs.mkdir(path.join(missionDir, "workpiece", ".astro"), { recursive: true });
      await fs.writeFile(path.join(astroCacheDir, "content.d.ts"), "// stale cache\n");
    });

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    vi.mocked(fs.rename).mockRestore();

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-m011");
    expect(existsSync(missionDir)).toBe(false);
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-m011"))).toBe(true);
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

  test("RFC-0796: stale symlink in missions/ root → trashed", async () => {
    // Create an archived mission
    const archiveMissionDir = path.join(missionsDir, "archive", "closed", "test-m012");
    await fs.mkdir(archiveMissionDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveMissionDir, "mission.yaml"),
      "missionId: test-m012\nstate: closed\n",
    );

    // Create a stale symlink pointing to the archived mission
    const symlinkPath = path.join(missionsDir, "test-m012");
    await fs.symlink(archiveMissionDir, symlinkPath);

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    // Symlink should be trashed
    expect(existsSync(symlinkPath)).toBe(false);
    // Archived mission should still exist
    expect(existsSync(archiveMissionDir)).toBe(true);
    // Should be reported as skipped with stale symlink reason
    expect(data.skipped.some((s) => s.reason === "stale symlink — trashed")).toBe(true);
  });

  test("RFC-0796: stale symlink in --dry-run → not trashed, reported", async () => {
    const archiveMissionDir = path.join(missionsDir, "archive", "closed", "test-m013");
    await fs.mkdir(archiveMissionDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveMissionDir, "mission.yaml"),
      "missionId: test-m013\nstate: closed\n",
    );

    const symlinkPath = path.join(missionsDir, "test-m013");
    await fs.symlink(archiveMissionDir, symlinkPath);

    const data = unwrap(
      await runMissionArchive(makeInput({ "dry-run": true }), makeContext(tmpDir)),
    );

    // In dry-run, symlink should NOT be trashed
    expect(existsSync(symlinkPath)).toBe(true);
    // But should be reported as skipped
    expect(data.skipped.some((s) => s.reason === "stale symlink — trashed")).toBe(true);
  });

  test("RFC-0801: service folders deleted before move", async () => {
    await writeMissionManifest(missionsDir, "test-m014", "closed");
    const missionDir = path.join(missionsDir, "test-m014");
    const workpieceDir = path.join(missionDir, "workpiece");
    await fs.mkdir(workpieceDir, { recursive: true });

    // Create service folders with dummy content
    for (const folder of ["node_modules", "dist", ".astro", ".wrangler", ".cache", ".turbo"]) {
      const folderPath = path.join(workpieceDir, folder);
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(path.join(folderPath, "dummy.txt"), `content of ${folder}\n`);
    }

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-m014");

    const archivedWorkpiece = path.join(missionsDir, "archive", "closed", "test-m014", "workpiece");
    for (const folder of ["node_modules", "dist", ".astro", ".wrangler", ".cache", ".turbo"]) {
      expect(existsSync(path.join(archivedWorkpiece, folder))).toBe(false);
    }
  });

  test("RFC-0801: mission without workpiece — cleanup skipped gracefully", async () => {
    await writeMissionManifest(missionsDir, "test-m015", "closed");
    // No workpiece/ directory created — simulates aborted mission

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-m015");
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-m015"))).toBe(true);
  });

  test("RFC-0801: --dry-run does not delete service folders", async () => {
    await writeMissionManifest(missionsDir, "test-m016", "closed");
    const missionDir = path.join(missionsDir, "test-m016");
    const workpieceDir = path.join(missionDir, "workpiece");
    await fs.mkdir(workpieceDir, { recursive: true });
    await fs.mkdir(path.join(workpieceDir, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(workpieceDir, "node_modules", "pkg.txt"), "content\n");

    const data = unwrap(
      await runMissionArchive(makeInput({ "dry-run": true }), makeContext(tmpDir)),
    );

    expect(data.dryRun).toBe(true);
    // Service folders should still exist at source in dry-run
    expect(existsSync(path.join(workpieceDir, "node_modules"))).toBe(true);
    expect(existsSync(path.join(workpieceDir, "node_modules", "pkg.txt"))).toBe(true);
  });
});
