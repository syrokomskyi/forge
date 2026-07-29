/*
<MODULE_CONTRACT>
<purpose>
RFC archive handler — moves terminal-status RFC files into status-specific
subdirectories under docs/rfcs/archive/ and moves non-terminal files found
in subdirectories back to the root.
</purpose>
<non-goals>
  <item>Does not validate RFC content — use rfc.validate for that.</item>
  <item>Does not change RFC frontmatter — only moves files on disk.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0367: implement rfc.archive command for terminal-status file archiving.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { listRfcFiles, readAndParseRfc } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { RFC_DIR } from "../types.ts";

export const RFC_TERMINAL_STATUSES = ["implemented", "rejected", "superseded"] as const;

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

export interface RfcArchiveResult {
  command: "rfc.archive";
  status: "ok";
  moved: ArchiveMove[];
  skipped: ArchiveSkip[];
  dryRun: boolean;
}

export async function runRfcArchive(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcArchiveResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const statusFilter = input.flags["status"] as string | undefined;

  if (statusFilter && !RFC_TERMINAL_STATUSES.includes(statusFilter as never)) {
    throw new Error(
      `Invalid --status "${statusFilter}". Must be one of: ${RFC_TERMINAL_STATUSES.join(", ")}`,
    );
  }

  const files = await listRfcFiles(rfcDirPath);
  const moved: ArchiveMove[] = [];
  const skipped: ArchiveSkip[] = [];

  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (!result) {
      skipped.push({
        id: "UNKNOWN",
        file: path.join(RFC_DIR, fileName),
        reason: "unreadable frontmatter",
      });
      continue;
    }

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "UNKNOWN");
    const status = String(fm["status"] ?? "").trim();
    const isTerminal = status === "implemented" || status === "rejected" || status === "superseded";
    const isInArchive = fileName.includes("/");
    const relFile = path.join(RFC_DIR, fileName);
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
      const targetDir = path.join(rfcDirPath, "archive", status);
      const targetPath = path.join(targetDir, basename);
      const targetRel = path.join(RFC_DIR, "archive", status, basename);

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
          await fs.rename(path.join(rfcDirPath, fileName), targetPath);
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
      const targetPath = path.join(rfcDirPath, basename);
      const targetRel = path.join(RFC_DIR, basename);

      try {
        await fs.access(targetPath);
        skipped.push({ id, file: relFile, reason: "destination exists" });
        continue;
      } catch {
        // destination doesn't exist — proceed
      }

      if (!dryRun) {
        try {
          await fs.rename(path.join(rfcDirPath, fileName), targetPath);
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
        `[dry-run] rfc.archive: would move ${moved.length} file(s), skip ${skipped.length}`,
      );
    } else {
      logger.success(`rfc.archive: moved ${moved.length} file(s), skipped ${skipped.length}`);
    }
    for (const m of moved) {
      logger.info(`  ${m.direction}: ${m.id} (${m.status}) ${m.from} → ${m.to}`);
    }
  }

  return {
    data: {
      command: "rfc.archive",
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
        action: "Run: pnpm exec site-kernel run rfc.list --json to verify archive status",
        kind: "optional",
      },
    ],
  };
}
