/*
<MODULE_CONTRACT>
<purpose>
Audit archive handler — moves audit files whose parent RFC has terminal status
into status-specific subdirectories under docs/audits/archive/ and moves
non-terminal files found in subdirectories back to the root. Standalone audit
files (not matching audit-rfc-XXXX-*) are silently excluded.
</purpose>
<non-goals>
  <item>Does not validate audit content.</item>
  <item>Does not change audit frontmatter — only moves files on disk.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: implement audit.archive command.</item>
  <item>RFC-0733: add pinned-files pre-check — skip pinned files with warning instead of moving them.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { listAuditFiles, extractRfcIdFromAuditFile } from "../frontmatter-io.ts";
import { loadRfcStatusMap } from "../../rfc/frontmatter-io.ts";
import type { ArchiveMove, ArchiveSkip } from "../../rfc/handlers/archive.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { AUDIT_DIR } from "../types.ts";
import type { AuditArchiveResult } from "../types.ts";
import { loadPinnedManifest, isPinned } from "../../core/handlers/pinned-check.ts";

const TERMINAL_STATUSES = ["implemented", "rejected", "superseded"] as const;

export async function runAuditArchive(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AuditArchiveResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const auditDirPath = path.join(workspaceRoot, AUDIT_DIR);
  const rfcDirPath = path.join(workspaceRoot, "docs", "rfcs");

  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const statusFilter = input.flags["status"] as string | undefined;

  if (statusFilter && !TERMINAL_STATUSES.includes(statusFilter as never)) {
    throw new Error(
      `Invalid --status "${statusFilter}". Must be one of: ${TERMINAL_STATUSES.join(", ")}`,
    );
  }

  const files = await listAuditFiles(auditDirPath);
  const rfcStatusMap = await loadRfcStatusMap(rfcDirPath);
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
    const rfcId = extractRfcIdFromAuditFile(fileName);
    const relFile = path.join(AUDIT_DIR, fileName);
    const basename = path.basename(fileName);

    if (!rfcId) {
      skipped.push({ id: "UNKNOWN", file: relFile, reason: "no RFC id in filename" });
      continue;
    }

    const rfcStatus = rfcStatusMap.get(rfcId);
    if (!rfcStatus) {
      skipped.push({ id: rfcId, file: relFile, reason: "parent RFC not found" });
      continue;
    }

    const isTerminal =
      rfcStatus === "implemented" || rfcStatus === "rejected" || rfcStatus === "superseded";
    const isInArchive = fileName.includes("/");

    if (statusFilter && rfcStatus !== statusFilter) {
      skipped.push({
        id: rfcId,
        file: relFile,
        reason: `parent RFC status ${rfcStatus} does not match --status ${statusFilter}`,
      });
      continue;
    }

    if (isTerminal && !isInArchive) {
      // RFC-0733: Check if file is pinned before moving
      if (pinnedManifest && isPinned(pinnedManifest, relFile)) {
        skipped.push({
          id: rfcId,
          file: relFile,
          reason: "pinned (protected by .forge/pinned.yaml)",
        });
        if (outputFormat === "pretty") {
          logger.warn(`  pinned: skipping ${relFile} (protected)`);
        }
        continue;
      }
      const targetDir = path.join(auditDirPath, "archive", rfcStatus);
      const targetPath = path.join(targetDir, basename);
      const targetRel = path.join(AUDIT_DIR, "archive", rfcStatus, basename);

      try {
        await fs.access(targetPath);
        skipped.push({ id: rfcId, file: relFile, reason: "destination exists" });
        continue;
      } catch {
        // destination doesn't exist — proceed
      }

      if (!dryRun) {
        await fs.mkdir(targetDir, { recursive: true });
        try {
          await fs.rename(path.join(auditDirPath, fileName), targetPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            skipped.push({ id: rfcId, file: relFile, reason: "already moved by another process" });
            continue;
          }
          throw err;
        }
      }

      moved.push({
        id: rfcId,
        file: targetRel,
        status: rfcStatus,
        from: relFile,
        to: targetRel,
        direction: "into-archive",
      });
    } else if (!isTerminal && isInArchive) {
      // RFC-0733: Check if file is pinned before moving
      if (pinnedManifest && isPinned(pinnedManifest, relFile)) {
        skipped.push({
          id: rfcId,
          file: relFile,
          reason: "pinned (protected by .forge/pinned.yaml)",
        });
        if (outputFormat === "pretty") {
          logger.warn(`  pinned: skipping ${relFile} (protected)`);
        }
        continue;
      }
      const targetPath = path.join(auditDirPath, basename);
      const targetRel = path.join(AUDIT_DIR, basename);

      try {
        await fs.access(targetPath);
        skipped.push({ id: rfcId, file: relFile, reason: "destination exists" });
        continue;
      } catch {
        // destination doesn't exist — proceed
      }

      if (!dryRun) {
        try {
          await fs.rename(path.join(auditDirPath, fileName), targetPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            skipped.push({ id: rfcId, file: relFile, reason: "already moved by another process" });
            continue;
          }
          throw err;
        }
      }

      moved.push({
        id: rfcId,
        file: targetRel,
        status: rfcStatus,
        from: relFile,
        to: targetRel,
        direction: "out-of-archive",
      });
    } else if (isTerminal && isInArchive) {
      skipped.push({ id: rfcId, file: relFile, reason: `already archived (${rfcStatus})` });
    } else {
      skipped.push({
        id: rfcId,
        file: relFile,
        reason: `parent RFC status ${rfcStatus} is non-terminal`,
      });
    }
  }

  if (outputFormat === "pretty") {
    if (dryRun) {
      logger.info(
        `[dry-run] audit.archive: would move ${moved.length} file(s), skip ${skipped.length}`,
      );
    } else {
      logger.success(`audit.archive: moved ${moved.length} file(s), skipped ${skipped.length}`);
    }
    for (const m of moved) {
      logger.info(`  ${m.direction}: ${m.id} (${m.status}) ${m.from} → ${m.to}`);
    }
  }

  return {
    data: {
      command: "audit.archive",
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
        action: "Run: pnpm exec site-kernel run audit.list --json to verify archive status",
        kind: "optional",
      },
    ],
  };
}
