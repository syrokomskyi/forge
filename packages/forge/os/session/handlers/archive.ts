/*
<MODULE_CONTRACT>
<purpose>
session.archive handler — moves session files older than --max-age-days from
docs/sessions/ to docs/sessions/archive/. Bidirectional: files in archive/
younger than threshold are moved back to docs/sessions/.
</purpose>
<non-goals>
  <item>Does not validate session content — that is session.validate.</item>
  <item>Does not change session frontmatter — only moves files on disk.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: implement session.archive command handler.</item>
  <item>RFC-0733: add pinned-files pre-check — skip pinned files with warning instead of moving them.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import {
  listSessionFiles,
  listArchivedSessionFiles,
  readAndParseSession,
} from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  SESSION_DIR,
  SESSION_ARCHIVE_SUBDIR,
  type SessionArchiveResult,
  type SessionArchiveMove,
  type SessionArchiveSkip,
} from "../types.ts";
import { loadPinnedManifest, isPinned, isIntraDirMove } from "../../core/handlers/pinned-check.ts";

const DEFAULT_MAX_AGE_DAYS = 7;

function parseSessionDate(fm: Record<string, unknown>): Date | null {
  const dateStr = String(fm["date"] ?? "");
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}

function computeAgeDays(sessionDate: Date, now: Date): number {
  const diffMs = now.getTime() - sessionDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export async function runSessionArchive(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SessionArchiveResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const sessionDirPath = path.join(workspaceRoot, SESSION_DIR);
  const archiveDirPath = path.join(sessionDirPath, SESSION_ARCHIVE_SUBDIR);

  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const maxAgeDaysRaw = input.flags["max-age-days"];
  const maxAgeDays =
    maxAgeDaysRaw !== undefined
      ? typeof maxAgeDaysRaw === "string"
        ? parseInt(maxAgeDaysRaw, 10)
        : typeof maxAgeDaysRaw === "number"
          ? maxAgeDaysRaw
          : DEFAULT_MAX_AGE_DAYS
      : DEFAULT_MAX_AGE_DAYS;

  if (isNaN(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`Invalid --max-age-days: must be a positive integer, got "${maxAgeDaysRaw}"`);
  }

  const now = new Date();
  const moved: SessionArchiveMove[] = [];
  const skipped: SessionArchiveSkip[] = [];

  // RFC-0733: Load pinned manifest once per invocation
  let pinnedManifest = null;
  try {
    pinnedManifest = await loadPinnedManifest(workspaceRoot);
  } catch {
    // Malformed manifest — skip pre-check
  }

  // Process active files — move to archive if older than threshold
  const activeFiles = await listSessionFiles(sessionDirPath);
  for (const fileName of activeFiles) {
    const result = await readAndParseSession(sessionDirPath, fileName);
    if (!result) {
      skipped.push({
        id: "UNKNOWN",
        file: path.join(SESSION_DIR, fileName),
        reason: "unreadable frontmatter",
      });
      continue;
    }

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "UNKNOWN");
    const sessionDate = parseSessionDate(fm);
    const relFile = path.join(SESSION_DIR, fileName);
    const basename = path.basename(fileName);

    if (!sessionDate) {
      skipped.push({ id, file: relFile, reason: "no valid date in frontmatter" });
      continue;
    }

    const ageDays = computeAgeDays(sessionDate, now);

    if (ageDays > maxAgeDays) {
      const targetPath = path.join(archiveDirPath, basename);
      const targetRel = path.join(SESSION_DIR, SESSION_ARCHIVE_SUBDIR, basename);

      // RFC-0733: Check if file is pinned before moving
      // Gap fix: exempt intra-directory moves (file stays within the same pinned dir)
      if (
        pinnedManifest &&
        isPinned(pinnedManifest, relFile) &&
        !isIntraDirMove(pinnedManifest, relFile, targetRel)
      ) {
        skipped.push({ id, file: relFile, reason: "pinned (protected by .forge/pinned.yaml)" });
        if (outputFormat === "pretty") {
          logger.warn(`  pinned: skipping ${relFile} (protected)`);
        }
        continue;
      }

      try {
        await fs.access(targetPath);
        skipped.push({ id, file: relFile, reason: "destination exists" });
        continue;
      } catch {
        // destination doesn't exist — proceed
      }

      if (!dryRun) {
        await fs.mkdir(archiveDirPath, { recursive: true });
        try {
          await fs.rename(path.join(sessionDirPath, fileName), targetPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            skipped.push({ id, file: relFile, reason: "already moved by another process" });
            continue;
          }
          throw err;
        }
      }

      moved.push({
        id,
        file: targetRel,
        from: relFile,
        to: targetRel,
        ageDays,
        direction: "into-archive",
      });
    } else {
      skipped.push({
        id,
        file: relFile,
        reason: `age ${ageDays} days < max-age ${maxAgeDays} days`,
      });
    }
  }

  // Process archived files — move back to active if younger than threshold
  const archivedFiles = await listArchivedSessionFiles(sessionDirPath);
  for (const archFileName of archivedFiles) {
    const archFullPath = path.join(archiveDirPath, archFileName);
    const result = await readAndParseSession(
      path.join(sessionDirPath, SESSION_ARCHIVE_SUBDIR),
      archFileName,
    );
    if (!result) {
      skipped.push({
        id: "UNKNOWN",
        file: path.join(SESSION_DIR, SESSION_ARCHIVE_SUBDIR, archFileName),
        reason: "unreadable frontmatter",
      });
      continue;
    }

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "UNKNOWN");
    const sessionDate = parseSessionDate(fm);
    const archRelFile = path.join(SESSION_DIR, SESSION_ARCHIVE_SUBDIR, archFileName);
    const basename = path.basename(archFileName);

    if (!sessionDate) {
      skipped.push({ id, file: archRelFile, reason: "no valid date in frontmatter" });
      continue;
    }

    const ageDays = computeAgeDays(sessionDate, now);

    if (ageDays <= maxAgeDays) {
      const targetPath = path.join(sessionDirPath, basename);
      const targetRel = path.join(SESSION_DIR, basename);

      // RFC-0733: Check if file is pinned before moving
      // Gap fix: exempt intra-directory moves (file stays within the same pinned dir)
      if (
        pinnedManifest &&
        isPinned(pinnedManifest, archRelFile) &&
        !isIntraDirMove(pinnedManifest, archRelFile, targetRel)
      ) {
        skipped.push({ id, file: archRelFile, reason: "pinned (protected by .forge/pinned.yaml)" });
        if (outputFormat === "pretty") {
          logger.warn(`  pinned: skipping ${archRelFile} (protected)`);
        }
        continue;
      }

      try {
        await fs.access(targetPath);
        skipped.push({ id, file: archRelFile, reason: "destination exists" });
        continue;
      } catch {
        // destination doesn't exist — proceed
      }

      if (!dryRun) {
        try {
          await fs.rename(archFullPath, targetPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            skipped.push({ id, file: archRelFile, reason: "already moved by another process" });
            continue;
          }
          throw err;
        }
      }

      moved.push({
        id,
        file: targetRel,
        from: archRelFile,
        to: targetRel,
        ageDays,
        direction: "out-of-archive",
      });
    } else {
      skipped.push({
        id,
        file: archRelFile,
        reason: `age ${ageDays} days > max-age ${maxAgeDays} days (already archived)`,
      });
    }
  }

  if (outputFormat === "pretty") {
    if (dryRun) {
      logger.info(
        `[dry-run] session.archive: would move ${moved.length} file(s), skip ${skipped.length}`,
      );
    } else {
      logger.success(`session.archive: moved ${moved.length} file(s), skipped ${skipped.length}`);
    }
    for (const m of moved) {
      logger.info(`  ${m.direction}: ${m.id} (age ${m.ageDays}d) ${m.from} → ${m.to}`);
    }
  }

  return {
    data: {
      command: "session.archive",
      status: "ok",
      moved,
      skipped,
      maxAgeDays,
      dryRun,
    },
    summary: dryRun
      ? `[dry-run] Would move ${moved.length} file(s), skip ${skipped.length}`
      : `Moved ${moved.length} file(s), skipped ${skipped.length}`,
    nextSteps: [
      {
        action: "Run: pnpm exec site-kernel run session.list --json to verify archive status",
        kind: "optional",
      },
    ],
  };
}
