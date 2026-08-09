/*
<MODULE_CONTRACT>
<purpose>
ADR archive handler — moves terminal-status ADR files into status-specific
subdirectories under docs/adrs/archive/ and moves non-terminal files found
in subdirectories back to the root.
</purpose>
<non-goals>
  <item>Does not validate ADR content — use adr.validate for that.</item>
  <item>Does not change ADR frontmatter — only moves files on disk.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0367: implement adr.archive command for terminal-status file archiving.</item>
  <item>RFC-0521: migrated from packages/os/site-kernel/src/adr/ to packages/forge/os/adr/.</item>
  <item>RFC-0733: add pinned-files pre-check — skip pinned files with warning instead of moving them.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { listAdrFiles, readAndParseAdr } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { ADR_DIR } from "../types.ts";
import { loadPinnedManifest, isPinned, isIntraDirMove } from "../../core/handlers/pinned-check.ts";

export const ADR_TERMINAL_STATUSES = ["implemented", "rejected", "superseded"] as const;

export interface ArchiveMove {
  id: string;
  file: string;
  status: string;
  from: string;
  to: string;
  direction: "into-archive" | "out-of-archive";
}

export interface ArchiveSkip {
  id: string;
  file: string;
  reason: string;
}

export interface AdrArchiveResult {
  command: "adr.archive";
  status: "ok";
  moved: ArchiveMove[];
  skipped: ArchiveSkip[];
  dryRun: boolean;
}

export async function runAdrArchive(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AdrArchiveResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const adrDirPath = path.join(workspaceRoot, ADR_DIR);

  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const statusFilter = input.flags["status"] as string | undefined;

  if (statusFilter && !ADR_TERMINAL_STATUSES.includes(statusFilter as never)) {
    throw new Error(
      `Invalid --status "${statusFilter}". Must be one of: ${ADR_TERMINAL_STATUSES.join(", ")}`,
    );
  }

  const files = await listAdrFiles(adrDirPath);
  const moved: ArchiveMove[] = [];
  const skipped: ArchiveSkip[] = [];

  // RFC-0733: Load pinned manifest once per invocation
  let pinnedManifest = null;
  try {
    pinnedManifest = await loadPinnedManifest(workspaceRoot);
  } catch {
    // Malformed manifest — skip pre-check
  }

  for (const fileName of files) {
    const result = await readAndParseAdr(adrDirPath, fileName);
    if (!result) {
      skipped.push({
        id: "UNKNOWN",
        file: path.join(ADR_DIR, fileName),
        reason: "unreadable frontmatter",
      });
      continue;
    }

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "UNKNOWN");
    const status = String(fm["status"] ?? "").trim();
    const isTerminal = status === "implemented" || status === "rejected" || status === "superseded";
    const isInArchive = fileName.includes("/");
    const relFile = path.join(ADR_DIR, fileName);
    const basename = path.basename(fileName);

    if (statusFilter && status !== statusFilter) {
      skipped.push({
        id,
        file: relFile,
        reason: `status ${status} does not match --status ${statusFilter}`,
      });
      continue;
    }

    if (isTerminal && !isInArchive) {
      const targetDir = path.join(adrDirPath, "archive", status);
      const targetPath = path.join(targetDir, basename);
      const targetRel = path.join(ADR_DIR, "archive", status, basename);

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
        await fs.mkdir(targetDir, { recursive: true });
        try {
          await fs.rename(path.join(adrDirPath, fileName), targetPath);
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
        status,
        from: relFile,
        to: targetRel,
        direction: "into-archive",
      });
    } else if (!isTerminal && isInArchive) {
      const targetPath = path.join(adrDirPath, basename);
      const targetRel = path.join(ADR_DIR, basename);

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
        try {
          await fs.rename(path.join(adrDirPath, fileName), targetPath);
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
        status,
        from: relFile,
        to: targetRel,
        direction: "out-of-archive",
      });
    } else if (isTerminal && isInArchive) {
      skipped.push({ id, file: relFile, reason: `already archived (${status})` });
    } else {
      skipped.push({ id, file: relFile, reason: `status ${status} is non-terminal` });
    }
  }

  if (outputFormat === "pretty") {
    if (dryRun) {
      logger.info(
        `[dry-run] adr.archive: would move ${moved.length} file(s), skip ${skipped.length}`,
      );
    } else {
      logger.success(`adr.archive: moved ${moved.length} file(s), skipped ${skipped.length}`);
    }
    for (const m of moved) {
      logger.info(`  ${m.direction}: ${m.id} (${m.status}) ${m.from} → ${m.to}`);
    }
  }

  return {
    data: {
      command: "adr.archive",
      status: "ok",
      moved,
      skipped,
      dryRun,
    },
    summary: dryRun
      ? `[dry-run] Would move ${moved.length} file(s), skip ${skipped.length}`
      : `Moved ${moved.length} file(s), skipped ${skipped.length}`,
    nextSteps: [
      {
        action: "Run: pnpm exec werkstatt run adr.list --json to verify archive status",
        kind: "optional",
      },
    ],
  };
}
