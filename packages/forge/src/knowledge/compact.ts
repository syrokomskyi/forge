/*
<MODULE_CONTRACT>
<purpose>Knowledge compaction planning and execution — archive aged/superseded entries, mark stale L2 principles (RFC-0662).</purpose>
<non-goals>
  <item>Do not distill or group entries semantically — that is the fo-knowledge-distill skill's job.</item>
  <item>Do not parse knowledge files — use parse.ts (RFC-0660).</item>
  <item>Do not serialize — use serialize.ts (RFC-0660).</item>
  <item>Do not wire into build pipelines or CI — invocation is operator-explicit.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0662: initial compaction module with planCompaction, executeCompaction, resolveRetentionDays, resolveStaleDays.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ParsedKnowledgeFile, KnowledgeEntry, KnowledgeEntryMeta } from "./schema.ts";
import { parseKnowledgeFile } from "./parse.ts";
import { serializeKnowledgeFile } from "./serialize.ts";
import { writeFileAtomic } from "../utils/fs-atomic.ts";

// ---------------------------------------------------------------------------
// Types (RFC-0662)
// ---------------------------------------------------------------------------

export interface CompactOptions {
  retentionDays: number;
  staleDays: number;
  today: string; // YYYY-MM-DD, injectable for tests
}

export type CompactActionKind =
  | "archive-expired"
  | "archive-superseded"
  | "archive-l0-retention"
  | "mark-stale";

export interface CompactAction {
  kind: CompactActionKind;
  file: string;
  entryId: string;
  reason: string;
}

export interface CompactFilePlan {
  file: string;
  archiveFile: string;
  actions: CompactAction[];
  legacySectionCount: number;
}

export interface CompactFileResult {
  file: string;
  archiveFile: string;
  actions: CompactAction[];
  legacySectionCount: number;
  archived: number;
  markedStale: number;
  written: boolean;
}

export interface CompactReport {
  command: string;
  status: "pass" | "fail";
  dryRun: boolean;
  files: CompactFileResult[];
  totals: { archived: number; markedStale: number; legacyFiles: number };
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_STALE_DAYS = 90;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseDate(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function daysBetween(from: string, to: string): number {
  const ms = parseDate(to) - parseDate(from);
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Archive companion path
// ---------------------------------------------------------------------------

function archiveCompanionPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base}.archive${ext}`);
}

// ---------------------------------------------------------------------------
// planCompaction — pure function
// ---------------------------------------------------------------------------

export function planCompaction(
  files: ParsedKnowledgeFile[],
  options: CompactOptions,
): CompactFilePlan[] {
  const plans: CompactFilePlan[] = [];

  for (const file of files) {
    // Skip knowledge-adjacent files (no structured entries)
    if (file.isKnowledgeAdjacent) continue;

    const actions: CompactAction[] = [];

    for (const entry of file.entries) {
      const meta = entry.meta;

      // 1. Expiry archive (all layers)
      if (meta.expiresAt !== undefined && meta.expiresAt !== null) {
        const diff = daysBetween(meta.expiresAt, options.today);
        if (diff > 0) {
          actions.push({
            kind: "archive-expired",
            file: file.path,
            entryId: meta.id,
            reason: `expiresAt ${meta.expiresAt} is past today ${options.today}`,
          });
          continue;
        }
      }

      // 2. Supersession archive (L1, L2)
      if (meta.status === "superseded") {
        actions.push({
          kind: "archive-superseded",
          file: file.path,
          entryId: meta.id,
          reason: `status is superseded`,
        });
        continue;
      }

      // 3. L0 retention archive
      if (file.layer === "L0" && meta.status === "active") {
        const age = daysBetween(meta.created, options.today);
        if (age > options.retentionDays) {
          actions.push({
            kind: "archive-l0-retention",
            file: file.path,
            entryId: meta.id,
            reason: `created ${meta.created} older than ${options.retentionDays} days`,
          });
          continue;
        }
      }

      // 4. L2 staleness marking
      if (
        file.layer === "L2" &&
        meta.status === "active" &&
        meta.lastConfirmedAt !== undefined &&
        meta.lastConfirmedAt !== null
      ) {
        const age = daysBetween(meta.lastConfirmedAt, options.today);
        if (age > options.staleDays) {
          actions.push({
            kind: "mark-stale",
            file: file.path,
            entryId: meta.id,
            reason: `lastConfirmedAt ${meta.lastConfirmedAt} older than ${options.staleDays} days`,
          });
        }
      }
    }

    plans.push({
      file: file.path,
      archiveFile: archiveCompanionPath(file.path),
      actions,
      legacySectionCount: file.legacySections.length,
    });
  }

  return plans;
}

// ---------------------------------------------------------------------------
// executeCompaction — I/O execution
// ---------------------------------------------------------------------------

export function executeCompaction(
  plans: CompactFilePlan[],
  dryRun: boolean,
): CompactReport {
  const fileResults: CompactFileResult[] = [];
  const errors: string[] = [];
  let totalArchived = 0;
  let totalMarkedStale = 0;
  let totalLegacyFiles = 0;

  for (const plan of plans) {
    // Parse the live file
    const parsed = parseKnowledgeFile(plan.file);

    // Refuse if parse issues
    if (parsed.parseIssues.length > 0) {
      errors.push(
        `${plan.file}: ${parsed.parseIssues.length} parse issue(s) — refusing to compact`,
      );
      fileResults.push({
        file: plan.file,
        archiveFile: plan.archiveFile,
        actions: plan.actions,
        legacySectionCount: plan.legacySectionCount,
        archived: 0,
        markedStale: 0,
        written: false,
      });
      continue;
    }

    // Build action lookup
    const actionByEntryId = new Map<string, CompactAction>();
    for (const action of plan.actions) {
      actionByEntryId.set(action.entryId, action);
    }

    // Partition entries
    const keepEntries: KnowledgeEntry[] = [];
    const archiveEntries: KnowledgeEntry[] = [];

    for (const entry of parsed.entries) {
      const action = actionByEntryId.get(entry.meta.id);
      if (action && action.kind.startsWith("archive-")) {
        archiveEntries.push(entry);
      } else if (action && action.kind === "mark-stale") {
        // Keep in place, update status
        keepEntries.push({
          ...entry,
          meta: { ...entry.meta, status: "stale" },
        });
      } else {
        keepEntries.push(entry);
      }
    }

    // Check archive companion for parse issues if it exists
    if (archiveEntries.length > 0 && fs.existsSync(plan.archiveFile)) {
      const archiveParsed = parseKnowledgeFile(plan.archiveFile);
      if (archiveParsed.parseIssues.length > 0) {
        errors.push(
          `${plan.archiveFile}: ${archiveParsed.parseIssues.length} parse issue(s) — refusing to compact`,
        );
        fileResults.push({
          file: plan.file,
          archiveFile: plan.archiveFile,
          actions: plan.actions,
          legacySectionCount: plan.legacySectionCount,
          archived: 0,
          markedStale: 0,
          written: false,
        });
        continue;
      }
    }

    const archived = archiveEntries.length;
    const markedStale = plan.actions.filter((a) => a.kind === "mark-stale").length;
    totalArchived += archived;
    totalMarkedStale += markedStale;
    if (plan.legacySectionCount > 0) totalLegacyFiles++;

    if (dryRun) {
      fileResults.push({
        file: plan.file,
        archiveFile: plan.archiveFile,
        actions: plan.actions,
        legacySectionCount: plan.legacySectionCount,
        archived,
        markedStale,
        written: false,
      });
      continue;
    }

    // Write live file (only if there are changes)
    if (plan.actions.length > 0) {
      const liveContent = serializeKnowledgeFile({
        ...parsed,
        entries: keepEntries,
      });
      try {
        fs.writeFileSync(plan.file, liveContent, "utf8");
      } catch (err) {
        errors.push(`${plan.file}: write failed — ${(err as Error).message}`);
      }
    }

    // Write archive companion (only if there are entries to archive)
    if (archiveEntries.length > 0) {
      let archiveParsed: ParsedKnowledgeFile;
      if (fs.existsSync(plan.archiveFile)) {
        archiveParsed = parseKnowledgeFile(plan.archiveFile);
      } else {
        // Create new archive file with a preamble
        const fileName = path.basename(plan.file);
        archiveParsed = {
          path: plan.archiveFile,
          layer: parsed.layer,
          preamble: `<!-- knowledge-layer: ${parsed.layer ?? "L0"} -->\n# ${fileName} (archive)\n\nArchived entries from ${fileName}. Generated by forge.skill.knowledge.compact (RFC-0662).`,
          entries: [],
          legacySections: [],
          parseIssues: [],
          isKnowledgeAdjacent: false,
        };
      }

      // Rewrite status for archived entries
      const archivedEntries: KnowledgeEntry[] = archiveEntries.map((entry) => {
        const action = actionByEntryId.get(entry.meta.id)!;
        const newMeta: KnowledgeEntryMeta = { ...entry.meta };
        if (action.kind === "archive-expired" || action.kind === "archive-l0-retention") {
          newMeta.status = "archived";
        }
        // For archive-superseded: keep status as "superseded" (preserves supersedes chain)
        return { ...entry, meta: newMeta };
      });

      const mergedContent = serializeKnowledgeFile({
        ...archiveParsed,
        entries: [...archiveParsed.entries, ...archivedEntries],
      });

      try {
        // Use atomic write for archive companion
        // writeFileAtomic is async, but we're in a sync context — use writeFileSync for simplicity
        // The staging + rename pattern is handled by writeFileAtomic for production use
        // For now, use direct write (the live file is already written non-atomically above)
        fs.writeFileSync(plan.archiveFile, mergedContent, "utf8");
      } catch (err) {
        errors.push(`${plan.archiveFile}: write failed — ${(err as Error).message}`);
      }
    }

    fileResults.push({
      file: plan.file,
      archiveFile: plan.archiveFile,
      actions: plan.actions,
      legacySectionCount: plan.legacySectionCount,
      archived,
      markedStale,
      written: true,
    });
  }

  return {
    command: "forge.skill.knowledge.compact",
    status: errors.length > 0 ? "fail" : "pass",
    dryRun,
    files: fileResults,
    totals: {
      archived: totalArchived,
      markedStale: totalMarkedStale,
      legacyFiles: totalLegacyFiles,
    },
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// resolveRetentionDays / resolveStaleDays — reads forge.yaml
// ---------------------------------------------------------------------------

export function resolveRetentionDays(workspaceRoot: string): number {
  try {
    const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
    const content = fs.readFileSync(forgeYamlPath, "utf8");
    const config = parseYaml(content) as Record<string, unknown>;
    const bindings = config?.bindings as Record<string, unknown> | undefined;
    const knowledge = bindings?.knowledge as Record<string, unknown> | undefined;
    const retentionDays = knowledge?.retentionDays;
    if (
      typeof retentionDays === "number" &&
      retentionDays > 0 &&
      Number.isInteger(retentionDays)
    ) {
      return retentionDays;
    }
    return DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

export function resolveStaleDays(workspaceRoot: string): number {
  try {
    const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
    const content = fs.readFileSync(forgeYamlPath, "utf8");
    const config = parseYaml(content) as Record<string, unknown>;
    const bindings = config?.bindings as Record<string, unknown> | undefined;
    const knowledge = bindings?.knowledge as Record<string, unknown> | undefined;
    const staleDays = knowledge?.staleDays;
    if (typeof staleDays === "number" && staleDays > 0 && Number.isInteger(staleDays)) {
      return staleDays;
    }
    return DEFAULT_STALE_DAYS;
  } catch {
    return DEFAULT_STALE_DAYS;
  }
}
