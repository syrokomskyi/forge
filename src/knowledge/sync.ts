/*
<MODULE_CONTRACT>
<purpose>Append-only sync for declared skill knowledge files. Copies files that are
missing at the destination, merges cumulative K-NNNN files by entry-ID union (local
entries always win), and never overwrites existing local content. Fixes the data-loss
bug where forge.upgrade wiped project-accumulated knowledge entries by overwriting
the synced copy with the package version.</purpose>
<non-goals>
  <item>Do not validate entry metadata — SKILL-19/SKILL-20 handle schema checks.</item>
  <item>Do not sync SKILL.md itself — callers handle that separately.</item>
  <item>Do not propagate deletions — knowledge files are append-only; removing entries is a compaction concern (compact.ts), not a sync concern.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>2026-09-24: initial append-only knowledge sync — merge by entry-ID union, local wins conflicts, skip divergent non-cumulative files, recurse into declared directories.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parseKnowledgeFile } from "./parse.ts";
import { serializeKnowledgeFile } from "./serialize.ts";
import type { ParsedKnowledgeFile } from "./schema.ts";

export type KnowledgeSyncAction = "copied" | "merged" | "unchanged" | "skipped";

export interface KnowledgeSyncResult {
  action: KnowledgeSyncAction;
  /** Entry IDs appended from the source file (merge only). */
  appended: string[];
  /** Entry IDs present in both files — the local version is always kept. */
  conflicts: string[];
}

export interface KnowledgeSyncPlan extends KnowledgeSyncResult {
  /** Serialized content to write at the destination, or null when no write is needed. */
  content: string | null;
}

const ACTION_PRIORITY: Record<KnowledgeSyncAction, number> = {
  merged: 3,
  copied: 2,
  skipped: 1,
  unchanged: 0,
};

function aggregateInto(target: KnowledgeSyncResult, sub: KnowledgeSyncResult): void {
  target.appended.push(...sub.appended);
  target.conflicts.push(...sub.conflicts);
  if (ACTION_PRIORITY[sub.action] > ACTION_PRIORITY[target.action]) {
    target.action = sub.action;
  }
}

function isCumulative(parsed: ParsedKnowledgeFile): boolean {
  return !parsed.isKnowledgeAdjacent;
}

function planFileSync(srcPath: string, destPath: string): KnowledgeSyncPlan {
  const none = { appended: [], conflicts: [] };
  if (!fs.existsSync(srcPath)) {
    return { action: "unchanged", content: null, ...none };
  }

  const srcContent = fs.readFileSync(srcPath, "utf8");
  if (!fs.existsSync(destPath)) {
    return { action: "copied", content: srcContent, ...none };
  }

  const destContent = fs.readFileSync(destPath, "utf8");
  if (srcContent === destContent) {
    return { action: "unchanged", content: null, ...none };
  }

  const srcParsed = parseKnowledgeFile(srcPath);
  const destParsed = parseKnowledgeFile(destPath);

  // Both files use the cumulative K-NNNN format → append-only merge:
  // local entries always win; source entries with new IDs are appended.
  if (isCumulative(srcParsed) && isCumulative(destParsed)) {
    const destIds = new Set(destParsed.entries.map((e) => e.meta.id));
    const appendedEntries = srcParsed.entries.filter((e) => !destIds.has(e.meta.id));
    const conflicts = srcParsed.entries
      .filter((e) => destIds.has(e.meta.id))
      .map((e) => e.meta.id);

    const destLegacyTexts = new Set(destParsed.legacySections.map((l) => l.text.trim()));
    const appendedLegacy = srcParsed.legacySections.filter(
      (l) => !destLegacyTexts.has(l.text.trim()),
    );

    if (appendedEntries.length === 0 && appendedLegacy.length === 0) {
      return { action: "unchanged", content: null, appended: [], conflicts };
    }

    const merged: ParsedKnowledgeFile = {
      path: destPath,
      layer: destParsed.layer ?? srcParsed.layer,
      preamble: destParsed.preamble || srcParsed.preamble,
      entries: [...destParsed.entries, ...appendedEntries],
      legacySections: [...destParsed.legacySections, ...appendedLegacy],
      parseIssues: [],
      isKnowledgeAdjacent: false,
    };

    return {
      action: "merged",
      content: serializeKnowledgeFile(merged),
      appended: appendedEntries.map((e) => e.meta.id),
      conflicts,
    };
  }

  // Any other divergence means the local file was edited or uses a
  // non-cumulative format — preserve it (append-only contract).
  return { action: "skipped", content: null, ...none };
}

/**
 * Compute the sync plan for a declared knowledge file (or directory) without
 * writing anything. Used by doctor for stale detection.
 */
export function planKnowledgeSync(srcPath: string, destPath: string): KnowledgeSyncPlan {
  if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
    const aggregate: KnowledgeSyncPlan = {
      action: "unchanged",
      appended: [],
      conflicts: [],
      content: null,
    };
    for (const entry of fs.readdirSync(srcPath)) {
      const sub = planKnowledgeSync(path.join(srcPath, entry), path.join(destPath, entry));
      aggregateInto(aggregate, sub);
    }
    return aggregate;
  }
  return planFileSync(srcPath, destPath);
}

/**
 * Sync one declared knowledge file (or directory) from source to destination.
 * Never overwrites existing local content — cumulative files merge by entry-ID
 * union, divergent non-cumulative files are skipped.
 */
export function syncKnowledgeFile(srcPath: string, destPath: string): KnowledgeSyncResult {
  if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
    const aggregate: KnowledgeSyncResult = { action: "unchanged", appended: [], conflicts: [] };
    for (const entry of fs.readdirSync(srcPath)) {
      const sub = syncKnowledgeFile(path.join(srcPath, entry), path.join(destPath, entry));
      aggregateInto(aggregate, sub);
    }
    return aggregate;
  }

  const plan = planFileSync(srcPath, destPath);
  if (plan.content !== null) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, plan.content, "utf8");
  }
  return { action: plan.action, appended: plan.appended, conflicts: plan.conflicts };
}
