/*
<MODULE_CONTRACT>
<purpose>Append-only sync and explicit collision planning for declared skill knowledge files. Copies files that are missing at the destination, merges cumulative entries by ID union (local entries always win), and resolves K-ID collisions only through an explicit remediation path.</purpose>
<non-goals>
  <item>Do not validate entry metadata — SKILL-19/SKILL-20 handle schema checks.</item>
  <item>Do not sync SKILL.md itself — callers handle that separately.</item>
  <item>Do not propagate deletions — knowledge files are append-only; removing entries is a compaction concern (compact.ts), not a sync concern.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0660: initial append-only knowledge sync — merge by entry-ID union, local wins conflicts, skip divergent non-cumulative files, recurse into declared directories.</item>
  <item>RFC-1481: pure conflict planner — preserve upstream canonical IDs, move divergent local entries into L-K-NNNN, deduplicate by exact title/body, and remap same-file references.</item>
  <item>RFC-1481: close REVIEW-CODE-2026-11-01-11 findings on resolver safety, IO boundaries, and reporting</item>
</CHANGE_SUMMARY>
*/

import * as fs from "../utils/sync-fs.ts";
import path from "node:path";
import { parseKnowledgeContent, parseKnowledgeFile } from "./parse.ts";
import { serializeKnowledgeFile } from "./serialize.ts";
import type { KnowledgeEntry, ParsedKnowledgeFile } from "./schema.ts";
import type { WorkspaceIO } from "../types.ts";

export type KnowledgeSyncAction = "copied" | "merged" | "unchanged" | "skipped";

export interface KnowledgeSyncResult {
  action: KnowledgeSyncAction;
  /** Entry IDs appended from the source file (merge only). */
  appended: string[];
  /** Entry IDs present in both files with differing content — the local version is kept. */
  conflicts: string[];
}

export interface KnowledgeSyncPlan extends KnowledgeSyncResult {
  /** Serialized content to write at the destination, or null when no write is needed. */
  content: string | null;
}

export interface KnowledgeConflictResolution {
  file: string;
  renumbered: { from: string; to: string }[];
  deduped: { localId: string; canonicalId: string }[];
  adopted: string[];
}

export type KnowledgeConflictUnresolvedReason =
  | "non-cumulative"
  | "parse-failure"
  | "ambiguous-identity"
  | "unmapped-reference";

export interface KnowledgeConflictIssue {
  file: string;
  reason: KnowledgeConflictUnresolvedReason;
}

export interface KnowledgeConflictResolutionPlan {
  content: string | null;
  resolution: KnowledgeConflictResolution;
  unresolved: KnowledgeConflictIssue[];
  /**
   * Entry IDs present in the destination after this plan applies — destination
   * IDs when the file stays untouched (unresolved or unchanged), output IDs
   * when the plan rewrites it. Cross-file reference remapping uses this to
   * prove an owner-scoped reference is unambiguous.
   */
  outputIds: string[];
}

export interface KnowledgeReferenceRemap {
  ids: ReadonlyMap<string, string>;
  ambiguous: ReadonlySet<string>;
}

const emptyResolution = (file: string): KnowledgeConflictResolution => ({
  file,
  renumbered: [],
  deduped: [],
  adopted: [],
});

function sameIdentity(left: KnowledgeEntry, right: KnowledgeEntry): boolean {
  return left.title === right.title && left.body === right.body;
}

function hasDuplicateIds(entries: KnowledgeEntry[]): boolean {
  return new Set(entries.map((entry) => entry.meta.id)).size !== entries.length;
}

/**
 * Allocate the next local namespace ID in one cumulative knowledge file.
 */
export function allocateLocalKnowledgeId(existingIds: string[]): string {
  const ordinals = existingIds
    .map((id) => id.match(/^L-K-(\d{4})$/)?.[1])
    .filter((ordinal): ordinal is string => ordinal !== undefined)
    .map(Number);
  const next = Math.max(0, ...ordinals) + 1;
  if (next > 9999) {
    throw new RangeError("No free L-K-NNNN identifier remains in this file.");
  }
  return `L-K-${String(next).padStart(4, "0")}`;
}

/**
 * Plan one file's collision resolution without performing filesystem writes.
 * The command layer owns workspace enumeration, locking, and persistence.
 */
export function planKnowledgeConflictResolution(
  source: ParsedKnowledgeFile,
  destination: ParsedKnowledgeFile,
  externalReferences: KnowledgeReferenceRemap = { ids: new Map(), ambiguous: new Set() },
): KnowledgeConflictResolutionPlan {
  const file = destination.path;
  const resolution = emptyResolution(file);
  const destinationIds = destination.entries.map((entry) => entry.meta.id);
  // Unresolved files are never written — return an empty resolution so no
  // partial mapping can leak into cross-file remaps or the resolved ledger.
  const unresolved = (reason: KnowledgeConflictUnresolvedReason): KnowledgeConflictResolutionPlan => ({
    content: null,
    resolution: emptyResolution(file),
    unresolved: [{ file, reason }],
    outputIds: destinationIds,
  });

  if (!isCumulative(source) || !isCumulative(destination)) {
    return unresolved("non-cumulative");
  }
  if (
    source.parseIssues.length > 0 ||
    destination.parseIssues.length > 0 ||
    hasDuplicateIds(source.entries) ||
    hasDuplicateIds(destination.entries)
  ) {
    return unresolved("parse-failure");
  }

  const sourceById = new Map(source.entries.map((entry) => [entry.meta.id, entry]));
  const usedSourceIds = new Set<string>();
  const idMap = new Map<string, string>();
  const outputEntries: KnowledgeEntry[] = [];
  const localOutputEntries: KnowledgeEntry[] = [];
  // Local-ID allocation must also skip L-K ids carried by the source file —
  // upstream pack knowledge may legally ship consumer-namespace entries.
  const localIds = [...destinationIds, ...source.entries.map((entry) => entry.meta.id)];
  let changed = false;

  for (const local of destination.entries) {
    const identityMatches = source.entries.filter((upstream) => sameIdentity(local, upstream));
    if (identityMatches.length > 1) {
      return unresolved("ambiguous-identity");
    }

    const sameId = sourceById.get(local.meta.id);
    if (sameId && sameIdentity(local, sameId)) {
      outputEntries.push(sameId);
      usedSourceIds.add(sameId.meta.id);
      if (!sameEntryContent(local, sameId)) {
        resolution.adopted.push(sameId.meta.id);
        changed = true;
      }
      continue;
    }

    const identityMatch = identityMatches[0];
    if (identityMatch) {
      idMap.set(local.meta.id, identityMatch.meta.id);
      resolution.deduped.push({
        localId: local.meta.id,
        canonicalId: identityMatch.meta.id,
      });
      changed = true;
      continue;
    }

    if (sameId) {
      // Namespace exhaustion propagates as a RangeError — it is a capacity
      // failure, not an identity ambiguity.
      const newId = allocateLocalKnowledgeId(localIds);
      localIds.push(newId);
      idMap.set(local.meta.id, newId);
      resolution.renumbered.push({ from: local.meta.id, to: newId });
      outputEntries.push({
        ...local,
        meta: { ...local.meta, id: newId },
      });
      localOutputEntries.push(outputEntries[outputEntries.length - 1]!);
      changed = true;
      continue;
    }

    outputEntries.push(local);
    localOutputEntries.push(local);
  }

  for (const upstream of source.entries) {
    if (usedSourceIds.has(upstream.meta.id)) continue;
    outputEntries.push(upstream);
    resolution.adopted.push(upstream.meta.id);
    changed = true;
  }

  const resolvableIds = new Set([
    ...outputEntries.map((entry) => entry.meta.id),
    ...source.entries.map((entry) => entry.meta.id),
  ]);
  for (const entry of localOutputEntries) {
    const meta = entry.meta;
    if (meta.supersedes) {
      const rewritten = meta.supersedes.map((id) => idMap.get(id) ?? id);
      if (rewritten.some((id) => !resolvableIds.has(id))) {
        return unresolved("unmapped-reference");
      }
      if (rewritten.some((id, index) => id !== meta.supersedes?.[index])) {
        meta.supersedes = rewritten;
        changed = true;
      }
    }
    if (meta.promotedTo) {
      if (externalReferences.ambiguous.has(meta.promotedTo)) {
        return unresolved("unmapped-reference");
      }
      const rewritten = externalReferences.ids.get(meta.promotedTo);
      if (rewritten && rewritten !== meta.promotedTo) {
        meta.promotedTo = rewritten;
        changed = true;
      }
    }
    if (meta.promotedFrom) {
      const rewritten = meta.promotedFrom.map((reference) => {
        if (externalReferences.ambiguous.has(reference)) return null;
        return externalReferences.ids.get(reference) ?? reference;
      });
      if (rewritten.some((reference) => reference === null)) {
        return unresolved("unmapped-reference");
      }
      if (rewritten.some((reference, index) => reference !== meta.promotedFrom?.[index])) {
        meta.promotedFrom = rewritten as string[];
        changed = true;
      }
    }
  }

  resolution.adopted = [...new Set(resolution.adopted)];

  if (!changed) {
    return {
      content: null,
      resolution,
      unresolved: [],
      outputIds: destinationIds,
    };
  }

  const merged: ParsedKnowledgeFile = {
    ...destination,
    entries: outputEntries,
  };
  return {
    content: serializeKnowledgeFile(merged),
    resolution,
    unresolved: [],
    outputIds: outputEntries.map((entry) => entry.meta.id),
  };
}

/**
 * Resolve one declared knowledge file through the caller's explicit IO port.
 * Missing source or destination files are left alone; upgrade owns first-copy
 * behavior, while this command only remediates files already present locally.
 */
export interface ResolveKnowledgeConflictsOptions {
  dryRun?: boolean;
  externalReferences?: KnowledgeReferenceRemap;
}

/**
 * Resolve one declared knowledge file through the caller's explicit IO port.
 * Missing source or destination files are left alone; upgrade owns first-copy
 * behavior, while this command only remediates files already present locally.
 * IO and capacity errors propagate to the caller — they are not knowledge
 * defects and must never masquerade as `parse-failure`.
 */
export async function resolveKnowledgeConflicts(
  srcPath: string,
  destPath: string,
  io: WorkspaceIO,
  options: ResolveKnowledgeConflictsOptions = {},
): Promise<KnowledgeConflictResolutionPlan> {
  if (!(await io.exists(srcPath)) || !(await io.exists(destPath))) {
    return {
      content: null,
      resolution: emptyResolution(destPath),
      unresolved: [],
      outputIds: [],
    };
  }

  const [sourceText, destinationText] = await Promise.all([
    io.readFile(srcPath),
    io.readFile(destPath),
  ]);
  const plan = planKnowledgeConflictResolution(
    parseKnowledgeContent(sourceText, srcPath),
    parseKnowledgeContent(destinationText, destPath),
    options.externalReferences,
  );
  if (plan.content !== null && options.dryRun !== true) {
    await io.writeFile(destPath, plan.content);
  }
  return plan;
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

function sameEntryContent(left: KnowledgeEntry, right: KnowledgeEntry): boolean {
  const leftMeta = Object.entries(left.meta).sort(([a], [b]) => a.localeCompare(b));
  const rightMeta = Object.entries(right.meta).sort(([a], [b]) => a.localeCompare(b));
  return (
    left.title === right.title &&
    left.body === right.body &&
    JSON.stringify(leftMeta) === JSON.stringify(rightMeta)
  );
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

  // Both files use the cumulative K/L-K entry format → append-only merge:
  // local entries always win; source entries with new IDs are appended.
  if (isCumulative(srcParsed) && isCumulative(destParsed)) {
    const destEntries = new Map(destParsed.entries.map((entry) => [entry.meta.id, entry]));
    const appendedEntries = srcParsed.entries.filter((entry) => !destEntries.has(entry.meta.id));
    const conflicts = srcParsed.entries
      .filter((entry) => {
        const localEntry = destEntries.get(entry.meta.id);
        return localEntry !== undefined && !sameEntryContent(entry, localEntry);
      })
      .map((entry) => entry.meta.id);

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
