/*
<MODULE_CONTRACT>
<purpose>
Unit tests for archive covering mission.archive. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the archive suite's contract for test-file scaffold coverage.</item>
  <item>RFC-1505: steps 3-5 — tracked lockfile restore, no side-effect commits</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runMissionArchive } from "./archive.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

vi.mock("../../../src/utils/fs-trash.ts", () => ({
  trashPath: (targetPath: string) => fs.rm(targetPath, { recursive: true, force: true }),
}));

const execSyncMock = vi.fn<(cmd: string, opts?: Record<string, unknown>) => string | Buffer>();
const execFileSyncMock = vi.fn<
  (cmd: string, args?: string[], opts?: Record<string, unknown>) => string | Buffer
>();

vi.mock("node:child_process", () => ({
  execSync: (cmd: string, opts?: Record<string, unknown>) => execSyncMock(cmd, opts),
  execFileSync: (cmd: string, args?: string[], opts?: Record<string, unknown>) =>
    execFileSyncMock(cmd, args, opts),
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
  execSyncMock.mockReset();
  execSyncMock.mockReturnValue("");
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue("");
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

  test("closed mission without releaseId → warns in pretty mode", async () => {
    await writeMissionManifest(missionsDir, "test-m007", "closed");
    const warnSpy = vi.fn();
    const ctx: ForgeRuntimeContext = {
      workspaceRoot: tmpDir,
      logger: {
        info: () => {},
        success: () => {},
        warn: warnSpy,
        error: () => {},
        debug: () => {},
      },
      outputFormat: "pretty",
      dryRun: false,
    } as unknown as ForgeRuntimeContext;

    await runMissionArchive(makeInput(), ctx);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-m007: closed mission has no releaseId"),
    );
  });

  test("closed mission with releaseId → no warning", async () => {
    const missionDir = path.join(missionsDir, "test-m008");
    await fs.mkdir(missionDir, { recursive: true });
    await fs.writeFile(
      path.join(missionDir, "mission.yaml"),
      `missionId: test-m008\nstate: closed\nreleaseId: test-r000001\n`,
    );
    const warnSpy = vi.fn();
    const ctx: ForgeRuntimeContext = {
      workspaceRoot: tmpDir,
      logger: {
        info: () => {},
        success: () => {},
        warn: warnSpy,
        error: () => {},
        debug: () => {},
      },
      outputFormat: "pretty",
      dryRun: false,
    } as unknown as ForgeRuntimeContext;

    await runMissionArchive(makeInput(), ctx);

    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" && c[0].includes("test-m008: closed mission has no releaseId"),
      ),
    ).toBe(false);
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

  test("unreadable manifest with empty dir → skipped with 'empty remnant' reason", async () => {
    const missionDir = path.join(missionsDir, "test-m008");
    await fs.mkdir(missionDir, { recursive: true });
    // No mission.yaml, no workpiece — empty remnant

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(0);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0].reason).toBe("empty remnant — use --clean-orphans to remove");
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
    // Mission carries a releaseId — already released, so the deferred-release
    // guard does not apply and all service folders are cleaned.
    const missionDir = path.join(missionsDir, "test-m014");
    await fs.mkdir(missionDir, { recursive: true });
    await fs.writeFile(
      path.join(missionDir, "mission.yaml"),
      `missionId: test-m014\nstate: closed\nreleaseId: test-r000014\n`,
    );
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

  test("deferred-release guard: closed mission without releaseId → node_modules preserved", async () => {
    await writeMissionManifest(missionsDir, "test-m014b", "closed");
    const missionDir = path.join(missionsDir, "test-m014b");
    const workpieceDir = path.join(missionDir, "workpiece");
    await fs.mkdir(workpieceDir, { recursive: true });

    for (const folder of ["node_modules", "dist", ".astro"]) {
      const folderPath = path.join(workpieceDir, folder);
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(path.join(folderPath, "dummy.txt"), `content of ${folder}\n`);
    }

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    const archivedWorkpiece = path.join(
      missionsDir,
      "archive",
      "closed",
      "test-m014b",
      "workpiece",
    );
    // node_modules preserved so release.prepare can still run on the archived
    // workpiece — archived dirs fall outside the pnpm-workspace glob.
    expect(existsSync(path.join(archivedWorkpiece, "node_modules"))).toBe(true);
    expect(existsSync(path.join(archivedWorkpiece, "node_modules", "dummy.txt"))).toBe(true);
    // Other service folders still cleaned.
    expect(existsSync(path.join(archivedWorkpiece, "dist"))).toBe(false);
    expect(existsSync(path.join(archivedWorkpiece, ".astro"))).toBe(false);
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

  test("RFC-0804: pnpm install called after moves", async () => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("");
    await writeMissionManifest(missionsDir, "test-m017", "closed");

    await runMissionArchive(makeInput(), makeContext(tmpDir));

    const installCall = execSyncMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("pnpm install"),
    );
    expect(installCall).toBeDefined();
    expect(installCall![1]).toMatchObject({ cwd: tmpDir });
  });

  test("RFC-1505 AC-4: install churn on pnpm-lock.yaml is restored from HEAD, never committed", async () => {
    const tracked = "lockfileVersion: '9.0'\n\nimporters: {}\n";
    const churned = `${tracked}\n  missions/test-m018/workpiece: {}\n`;
    const lockfilePath = path.join(tmpDir, "pnpm-lock.yaml");
    writeFileSync(lockfilePath, tracked);
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("pnpm install")) {
        writeFileSync(lockfilePath, churned);
        return "";
      }
      return "";
    });
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === "git" && args?.[0] === "show") return tracked;
      return "";
    });
    await writeMissionManifest(missionsDir, "test-m018", "closed");

    await runMissionArchive(makeInput(), makeContext(tmpDir));

    expect(readFileSync(lockfilePath, "utf-8")).toBe(tracked);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["show", "HEAD:pnpm-lock.yaml"],
      expect.objectContaining({ cwd: tmpDir }),
    );
    const gitWrites = execSyncMock.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        (c[0].startsWith("git add") ||
          c[0].startsWith("git rm") ||
          c[0].startsWith("git commit") ||
          c[0].startsWith("git status")),
    );
    expect(gitWrites).toEqual([]);
  });

  test("RFC-1505 AC-4: no tracked lockfile at HEAD → churn left in place, no git calls", async () => {
    const churned = "lockfileVersion: '9.0'\n# local churn\n";
    const lockfilePath = path.join(tmpDir, "pnpm-lock.yaml");
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("pnpm install")) {
        writeFileSync(lockfilePath, churned);
        return "";
      }
      return "";
    });
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("fatal: path does not exist"), { status: 128 });
    });
    await writeMissionManifest(missionsDir, "test-m018b", "closed");

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(readFileSync(lockfilePath, "utf-8")).toBe(churned);
    const gitCalls = execSyncMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("git"),
    );
    expect(gitCalls).toEqual([]);
  });

  test("RFC-0804: pnpm install failure is non-fatal", async () => {
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("pnpm install")) throw new Error("ECONNREFUSED");
      return "";
    });
    await writeMissionManifest(missionsDir, "test-m019", "closed");

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-m019");
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-m019"))).toBe(true);
  });

  test("RFC-0804: dry-run skips lockfile refresh", async () => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("");
    await writeMissionManifest(missionsDir, "test-m020", "closed");

    await runMissionArchive(makeInput({ "dry-run": true }), makeContext(tmpDir));

    const installCall = execSyncMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("pnpm install"),
    );
    expect(installCall).toBeUndefined();
  });

  test("RFC-0804: no moves skips lockfile refresh", async () => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("");

    await runMissionArchive(makeInput(), makeContext(tmpDir));

    const installCall = execSyncMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("pnpm install"),
    );
    expect(installCall).toBeUndefined();
  });

  // RFC-0982: Fallback state detection and --clean-orphans tests

  test("RFC-0982: orphaned workpiece with only .astro/ cache → state detected as closed, archived", async () => {
    const missionDir = path.join(missionsDir, "test-r982-01");
    const workpieceDir = path.join(missionDir, "workpiece");
    await fs.mkdir(path.join(workpieceDir, ".astro"), { recursive: true });
    await fs.writeFile(path.join(workpieceDir, ".astro", "cache.txt"), "cache\n");
    // No mission.yaml — orphaned remnant

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-r982-01");
    expect(data.moved[0].state).toBe("closed");
    expect(data.moved[0].direction).toBe("into-archive");
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-r982-01"))).toBe(true);
  });

  test("RFC-0982: .closed marker fallback → state detected as closed", async () => {
    const missionDir = path.join(missionsDir, "test-r982-02");
    const workpieceDir = path.join(missionDir, "workpiece");
    await fs.mkdir(workpieceDir, { recursive: true });
    await fs.writeFile(path.join(workpieceDir, ".closed"), "2026-08-29T12:00:00Z\n");
    // Also add a source file so it's not cache-only
    await fs.writeFile(path.join(workpieceDir, "src.ts"), "// source\n");
    // No mission.yaml — but .closed marker present

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-r982-02");
    expect(data.moved[0].state).toBe("closed");
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-r982-02"))).toBe(true);
  });

  test("RFC-0982: --clean-orphans trashes orphaned remnant dir", async () => {
    const missionDir = path.join(missionsDir, "test-r982-03");
    const workpieceDir = path.join(missionDir, "workpiece");
    await fs.mkdir(path.join(workpieceDir, ".astro"), { recursive: true });
    await fs.writeFile(path.join(workpieceDir, ".astro", "cache.txt"), "cache\n");
    // No mission.yaml — orphaned remnant with only cache

    const data = unwrap(
      await runMissionArchive(makeInput({ "clean-orphans": true }), makeContext(tmpDir)),
    );

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-r982-03");
    expect(data.moved[0].direction).toBe("trashed-orphan");
    expect(data.moved[0].to).toBe("(trashed)");
    expect(existsSync(missionDir)).toBe(false);
  });

  test("RFC-0982: --clean-orphans --dry-run → reported but not trashed", async () => {
    const missionDir = path.join(missionsDir, "test-r982-04");
    const workpieceDir = path.join(missionDir, "workpiece");
    await fs.mkdir(path.join(workpieceDir, ".astro"), { recursive: true });
    await fs.writeFile(path.join(workpieceDir, ".astro", "cache.txt"), "cache\n");

    const data = unwrap(
      await runMissionArchive(
        makeInput({ "clean-orphans": true, "dry-run": true }),
        makeContext(tmpDir),
      ),
    );

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].direction).toBe("trashed-orphan");
    expect(data.dryRun).toBe(true);
    // Dir should still exist in dry-run
    expect(existsSync(missionDir)).toBe(true);
  });

  test("RFC-0982: --clean-orphans skips non-orphaned dir with mission.yaml", async () => {
    await writeMissionManifest(missionsDir, "test-r982-05", "closed");
    const workpieceDir = path.join(missionsDir, "test-r982-05", "workpiece");
    await fs.mkdir(path.join(workpieceDir, ".astro"), { recursive: true });

    const data = unwrap(
      await runMissionArchive(makeInput({ "clean-orphans": true }), makeContext(tmpDir)),
    );

    // Should be archived normally, not trashed
    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].direction).toBe("into-archive");
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-r982-05"))).toBe(true);
  });

  test("RFC-0982: skip reason 'manually inspect' for dir with non-cache content but no mission.yaml", async () => {
    const missionDir = path.join(missionsDir, "test-r982-06");
    const workpieceDir = path.join(missionDir, "workpiece");
    await fs.mkdir(workpieceDir, { recursive: true });
    // Source file in workpiece — non-cache content, no .closed marker
    await fs.writeFile(path.join(workpieceDir, "src.ts"), "// source code\n");
    // No mission.yaml

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(0);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0].reason).toContain("manually inspect");
  });

  test("RFC-0982: --clean-orphans trashes empty remnant dir (no workpiece, no mission.yaml)", async () => {
    const missionDir = path.join(missionsDir, "test-r982-08");
    await fs.mkdir(missionDir, { recursive: true });
    // No mission.yaml, no workpiece — empty remnant, state would be null

    const data = unwrap(
      await runMissionArchive(makeInput({ "clean-orphans": true }), makeContext(tmpDir)),
    );

    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].missionId).toBe("test-r982-08");
    expect(data.moved[0].direction).toBe("trashed-orphan");
    expect(existsSync(missionDir)).toBe(false);
  });

  test("RFC-0982: skip reason 'use --clean-orphans' for empty remnant dir", async () => {
    const missionDir = path.join(missionsDir, "test-r982-07");
    await fs.mkdir(missionDir, { recursive: true });
    // No mission.yaml, no workpiece, no content — empty remnant

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(0);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0].reason).toContain("use --clean-orphans");
  });

  test("RFC-1505: archive never stages or commits mission moves — no git calls at all", async () => {
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("pnpm install")) return "";
      return "";
    });
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue("tracked\n");
    await writeMissionManifest(missionsDir, "test-r1138-01", "closed");

    const data = unwrap(await runMissionArchive(makeInput(), makeContext(tmpDir)));

    expect(data.moved).toHaveLength(1);
    expect(existsSync(path.join(missionsDir, "archive", "closed", "test-r1138-01"))).toBe(
      true,
    );
    const gitCalls = execSyncMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("git"),
    );
    expect(gitCalls).toEqual([]);
  });

  test("RFC-1505: restore runs on any branch — no protected-branch check remains", async () => {
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith("pnpm install")) return "";
      return "";
    });
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === "git" && args?.[0] === "show") return "tracked\n";
      return "";
    });
    // A flow-adopted checkout on a protected branch — RFC-1505 removes the
    // branch check entirely: no symbolic-ref probe, no staging, no commits.
    await fs.mkdir(path.join(tmpDir, "hooks"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "hooks", "flow-guard.sh"), "#!/bin/sh\n");
    await writeMissionManifest(missionsDir, "test-r1138-02", "closed");

    await runMissionArchive(makeInput(), makeContext(tmpDir));

    const gitCalls = execSyncMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("git"),
    );
    expect(gitCalls).toEqual([]);
  });
});
