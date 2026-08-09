/*
<MODULE_CONTRACT>
<purpose>
Mission archive handler — moves terminal-state mission directories (state: closed
or state: aborted in mission.yaml) into status-specific subdirectories under
missions/archive/<state>/ and moves non-terminal (open) directories found in
archive subdirectories back to missions/.
</purpose>
<non-goals>
  <item>Does not validate mission manifest schema — reads only the state field.</item>
  <item>Does not change mission.yaml — only moves directories on disk.</item>
  <item>Does not import from @warpgogol/* packages — uses node:fs and yaml only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0573: implement mission.archive command.</item>
  <item>RFC-0573: extract moveMissionDir helper to eliminate Phase 1/2 duplication.</item>
  <item>Replace fs.rm with trashPath for post-rename cleanup (trash bin for LLM-initiated deletions).</item>
  <item>RFC-0733: add pinned-files pre-check — skip pinned mission directories with warning instead of moving them.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { trashPath } from "../../../src/utils/fs-trash.ts";
import {
  MISSIONS_DIR,
  ARCHIVE_DIR_NAME,
  MISSION_TERMINAL_STATUSES,
  type MissionArchiveMove,
  type MissionArchiveSkip,
  type MissionArchiveResult,
} from "../types.ts";
import { loadPinnedManifest, isPinned, isIntraDirMove } from "../../core/handlers/pinned-check.ts";

async function readMissionState(missionDir: string): Promise<string | null> {
  const manifestPath = path.join(missionDir, "mission.yaml");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const state = parsed?.state;
    if (typeof state === "string") return state.trim();
    return null;
  } catch {
    return null;
  }
}

interface MoveAttempt {
  moved: MissionArchiveMove | null;
  skip: MissionArchiveSkip | null;
}

async function moveMissionDir(
  sourcePath: string,
  targetPath: string,
  targetParentDir: string,
  missionId: string,
  state: string,
  sourceRel: string,
  targetRel: string,
  direction: "into-archive" | "out-of-archive",
  dryRun: boolean,
): Promise<MoveAttempt> {
  if (existsSync(targetPath)) {
    return { moved: null, skip: { missionId, dir: sourceRel, reason: "destination exists" } };
  }

  if (!dryRun) {
    if (targetParentDir) {
      await fs.mkdir(targetParentDir, { recursive: true });
    }
    try {
      await fs.rename(sourcePath, targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          moved: null,
          skip: { missionId, dir: sourceRel, reason: "already moved by another process" },
        };
      }
      throw err;
    }

    // Post-rename cleanup: a watcher or IDE may recreate stale cache
    // directories (e.g. .astro/) at the source path after the rename.
    // Remove the resurrected source so it doesn't leave orphan directories.
    if (existsSync(sourcePath)) {
      await trashPath(sourcePath);
    }
  }

  return {
    moved: { missionId, state, from: sourceRel, to: targetRel, direction },
    skip: null,
  };
}

export async function runMissionArchive(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<MissionArchiveResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const missionsPath = path.join(workspaceRoot, MISSIONS_DIR);

  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const statusFilter = input.flags["status"] as string | undefined;

  if (statusFilter && !MISSION_TERMINAL_STATUSES.includes(statusFilter as never)) {
    throw new Error(
      `Invalid --status "${statusFilter}". Must be one of: ${MISSION_TERMINAL_STATUSES.join(", ")}`,
    );
  }

  const moved: MissionArchiveMove[] = [];
  const skipped: MissionArchiveSkip[] = [];

  // RFC-0733: Load pinned manifest once per invocation
  let pinnedManifest = null;
  try {
    pinnedManifest = await loadPinnedManifest(workspaceRoot);
  } catch {
    // Malformed manifest — skip pre-check
  }

  if (!existsSync(missionsPath)) {
    if (outputFormat === "pretty") {
      if (dryRun) {
        logger.info("[dry-run] mission.archive: no missions/ directory — nothing to do");
      } else {
        logger.info("mission.archive: no missions/ directory — nothing to do");
      }
    }
    return {
      data: { command: "mission.archive", status: "ok", moved, skipped, dryRun },
      summary: dryRun
        ? "[dry-run] No missions/ directory — nothing to do"
        : "No missions/ directory — nothing to do",
    };
  }

  // Phase 1: Scan missions/ for terminal-state missions to move into archive
  const rootEntries = await fs.readdir(missionsPath, { withFileTypes: true });
  const rootDirs = rootEntries
    .filter((e) => e.isDirectory() && e.name !== ARCHIVE_DIR_NAME)
    .map((e) => e.name);

  for (const missionId of rootDirs) {
    const missionDir = path.join(missionsPath, missionId);
    const state = await readMissionState(missionDir);

    if (state === null) {
      skipped.push({
        missionId,
        dir: `${MISSIONS_DIR}/${missionId}`,
        reason: "unreadable manifest",
      });
      continue;
    }

    const isTerminal = MISSION_TERMINAL_STATUSES.includes(state as never);

    if (!isTerminal) {
      skipped.push({
        missionId,
        dir: `${MISSIONS_DIR}/${missionId}`,
        reason: `state ${state} is non-terminal`,
      });
      continue;
    }

    if (statusFilter && state !== statusFilter) {
      skipped.push({
        missionId,
        dir: `${MISSIONS_DIR}/${missionId}`,
        reason: `state ${state} does not match --status ${statusFilter}`,
      });
      continue;
    }

    const targetDir = path.join(missionsPath, ARCHIVE_DIR_NAME, state);
    const targetPath = path.join(targetDir, missionId);
    const targetRel = `${MISSIONS_DIR}/${ARCHIVE_DIR_NAME}/${state}/${missionId}`;
    const sourceRel = `${MISSIONS_DIR}/${missionId}`;

    // RFC-0733: Check if mission directory is pinned before moving
    // Gap fix: exempt intra-directory moves (dir stays within the same pinned parent)
    if (
      pinnedManifest &&
      isPinned(pinnedManifest, sourceRel) &&
      !isIntraDirMove(pinnedManifest, sourceRel, targetRel)
    ) {
      skipped.push({
        missionId,
        dir: sourceRel,
        reason: "pinned (protected by .forge/pinned.yaml)",
      });
      if (outputFormat === "pretty") {
        logger.warn(`  pinned: skipping ${sourceRel} (protected)`);
      }
      continue;
    }

    const result = await moveMissionDir(
      missionDir,
      targetPath,
      targetDir,
      missionId,
      state,
      sourceRel,
      targetRel,
      "into-archive",
      dryRun,
    );
    if (result.skip) {
      skipped.push(result.skip);
      continue;
    }
    if (result.moved) moved.push(result.moved);
  }

  // Phase 2: Scan missions/archive/<state>/ for non-terminal missions to move back
  const archivePath = path.join(missionsPath, ARCHIVE_DIR_NAME);
  if (existsSync(archivePath)) {
    const stateDirs = await fs.readdir(archivePath, { withFileTypes: true });
    const stateDirNames = stateDirs.filter((e) => e.isDirectory()).map((e) => e.name);

    for (const stateDirName of stateDirNames) {
      const stateDirPath = path.join(archivePath, stateDirName);
      const archivedMissions = await fs.readdir(stateDirPath, { withFileTypes: true });
      const archivedDirNames = archivedMissions.filter((e) => e.isDirectory()).map((e) => e.name);

      for (const missionId of archivedDirNames) {
        const archivedMissionDir = path.join(stateDirPath, missionId);
        const state = await readMissionState(archivedMissionDir);

        if (state === null) {
          skipped.push({
            missionId,
            dir: `${MISSIONS_DIR}/${ARCHIVE_DIR_NAME}/${stateDirName}/${missionId}`,
            reason: "unreadable manifest",
          });
          continue;
        }

        const isTerminal = MISSION_TERMINAL_STATUSES.includes(state as never);

        if (isTerminal) {
          skipped.push({
            missionId,
            dir: `${MISSIONS_DIR}/${ARCHIVE_DIR_NAME}/${stateDirName}/${missionId}`,
            reason: `already archived (${state})`,
          });
          continue;
        }

        // Non-terminal in archive — move back to missions/
        const targetPath = path.join(missionsPath, missionId);
        const targetRel = `${MISSIONS_DIR}/${missionId}`;
        const sourceRel = `${MISSIONS_DIR}/${ARCHIVE_DIR_NAME}/${stateDirName}/${missionId}`;

        // RFC-0733: Check if mission directory is pinned before moving
        // Gap fix: exempt intra-directory moves (dir stays within the same pinned parent)
        if (
          pinnedManifest &&
          isPinned(pinnedManifest, sourceRel) &&
          !isIntraDirMove(pinnedManifest, sourceRel, targetRel)
        ) {
          skipped.push({
            missionId,
            dir: sourceRel,
            reason: "pinned (protected by .forge/pinned.yaml)",
          });
          if (outputFormat === "pretty") {
            logger.warn(`  pinned: skipping ${sourceRel} (protected)`);
          }
          continue;
        }

        const result = await moveMissionDir(
          archivedMissionDir,
          targetPath,
          "",
          missionId,
          state,
          sourceRel,
          targetRel,
          "out-of-archive",
          dryRun,
        );
        if (result.skip) {
          skipped.push(result.skip);
          continue;
        }
        if (result.moved) moved.push(result.moved);
      }
    }
  }

  if (outputFormat === "pretty") {
    if (dryRun) {
      logger.info(
        `[dry-run] mission.archive: would move ${moved.length} mission(s), skip ${skipped.length}`,
      );
    } else {
      logger.success(
        `mission.archive: moved ${moved.length} mission(s), skipped ${skipped.length}`,
      );
    }
    for (const m of moved) {
      logger.info(`  ${m.direction}: ${m.missionId} (${m.state}) ${m.from} → ${m.to}`);
    }
  }

  return {
    data: {
      command: "mission.archive",
      status: "ok",
      moved,
      skipped,
      dryRun,
    },
    summary: dryRun
      ? `[dry-run] Would move ${moved.length} mission(s), skip ${skipped.length}`
      : `Moved ${moved.length} mission(s), skipped ${skipped.length}`,
    nextSteps: [
      {
        action: "Run: pnpm exec werkstatt run mission.list --json to verify active missions",
        kind: "optional",
      },
    ],
  };
}
