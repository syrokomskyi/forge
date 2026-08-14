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
  <item>RFC-0733: add pinned-files pre-check — skip pinned files with warning instead of moving them.</item>
  <item>Gap fix: automatically rebuild docs/rfcs/index.yaml after moves to prevent stale index.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { listRfcFiles, readAndParseRfc } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { RFC_DIR } from "../types.ts";
import { toIsoDate } from "./shared.ts";
import { loadPinnedManifest, isPinned, isIntraDirMove } from "../../core/handlers/pinned-check.ts";

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
  indexRefreshed: boolean;
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

  // RFC-0733: Load pinned manifest once per invocation (null = no manifest, protection inactive)
  let pinnedManifest = null;
  try {
    pinnedManifest = await loadPinnedManifest(workspaceRoot);
  } catch {
    // Malformed manifest — skip pre-check, let pinned.validate report it
  }

  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (!result || "error" in result) {
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

  // Gap fix: rebuild docs/rfcs/index.yaml after moves to prevent stale index.
  // Previously, rfc.archive moved files but left index.yaml out of date —
  // archived RFCs disappeared from the index silently.
  let indexRefreshed = false;
  if (!dryRun && moved.length > 0) {
    try {
      const allFiles = await listRfcFiles(rfcDirPath);
      const entries: Array<Record<string, unknown>> = [];
      for (const fileName of allFiles) {
        const result = await readAndParseRfc(rfcDirPath, fileName);
        if (!result || "error" in result) continue;
        const fm = result.parsed.frontmatter;
        const arr = (k: string): string[] =>
          Array.isArray(fm[k]) ? (fm[k] as unknown[]).map(String) : [];
        entries.push({
          id: String(fm["id"] ?? ""),
          title: String(fm["title"] ?? ""),
          status: String(fm["status"] ?? ""),
          kind: String(fm["kind"] ?? ""),
          createdAt: String(fm["createdAt"] ?? ""),
          implementedAt: String(fm["implementedAt"] ?? ""),
          closedAt: String(fm["closedAt"] ?? ""),
          supersedes: arr("supersedes"),
          supersededBy: String(fm["supersededBy"] ?? ""),
          amends: arr("amends"),
          amendedBy: arr("amendedBy"),
          related: arr("related"),
          file: path.join(RFC_DIR, fileName),
        });
      }
      entries.sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));
      const outRel = path.join(RFC_DIR, "index.yaml");
      const payload = {
        command: "rfc.index.generate",
        generatedAt: toIsoDate(new Date()),
        count: entries.length,
        entries,
      };
      await fs.writeFile(path.join(workspaceRoot, outRel), `${yamlStringify(payload)}`, "utf-8");
      indexRefreshed = true;
      if (outputFormat === "pretty") {
        logger.info(`rfc.archive: refreshed ${outRel} (${entries.length} entries)`);
      }
    } catch (refreshErr) {
      if (outputFormat === "pretty") {
        logger.warn(
          `rfc.archive: index refresh failed — run 'pnpm exec werkstatt run rfc.index.generate --write' manually: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
        );
      }
    }
  }

  return {
    data: {
      command: "rfc.archive",
      status: "ok",
      moved,
      skipped,
      dryRun,
      indexRefreshed,
    },
    summary: dryRun
      ? `[dry-run] Would move ${moved.length} file(s), skip ${skipped.length}`
      : `Moved ${moved.length} file(s), skipped ${skipped.length}`,
    nextSteps: [
      {
        action: "Run: pnpm exec werkstatt run rfc.list --json to verify archive status",
        kind: "optional",
      },
    ],
  };
}
