/*
<MODULE_CONTRACT>
<purpose>compass.migrate domain logic — the v1 to v2 Compass header codemod
(RFC-1097). Rewrites authored file headers in place: collapses CHANGE_SUMMARY
windows into history, strips forbidden v1 blocks, seeds KEY_DECISIONS from
ai-invariant comments, reorders blocks to canonical order, and reports a
closed action union per file. Pure per-file transform plus a workspace
walker; the kernel handler lives in compass-migrate-handler.ts.</purpose>
<non-goals>
  <item>Do not author headers from scratch — files with no Compass header are reported no-header and skipped; the agent sweep writes them.</item>
  <item>Do not rewrite purpose text — boilerplate purposes are flagged for the sweep, not auto-fixed.</item>
  <item>Do not import @warpgogol/* packages — this module is autonomous (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>migrateFile is a pure source-to-source function so every action is unit-testable without I/O.</item>
  <item>Collapse reuses the summary.trim repair semantics — ID-less items dropped, overflow IDs merged into history.</item>
  <item>Seeded KEY_DECISIONS strip the leading governance-ID prefix so items satisfy COMPASS-KD-05 immediately.</item>
  <item>Reorder only fires when the inter-block region is whitespace — interleaved content is left for the sweep.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1097: initial codemod — migrateFile pure transform, migrateWorkspace walker, closed action union.</item>
  <item>RFC-1097: steps 1-4 — compass.migrate codemod

Add the v1 to v2 Compass header codemod: migrateFile pure transform (collapse, strip, seed, reorder, purpose-flag actions), migrateWorkspace walker, runCompassMigrate handler with dirty-tree refusal and --force/--files/--dry-run flags, module registration, and 15 unit tests.</item>
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  createCompassInventoryEntries,
  detectRiskClass,
  getEntrySource,
  getRelativeSegments,
  getWorkspaceRelativeSegments,
} from "./compass-inventory.ts";
import {
  buildChangeSummaryBlock,
  CHANGE_SUMMARY_WINDOW,
  getLineCommentPrefix,
  mergeHistoryIds,
  parseChangeSummary,
} from "./summary-record.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import type { CompassPolicy } from "../policy.ts";
import type { ForgeCommandInput } from "../../../src/types.ts";

export type MigrateAction =
  | "collapsed"
  | "stripped"
  | "seeded"
  | "todo"
  | "purpose-flagged"
  | "reordered"
  | "unparseable"
  | "no-header"
  | "unchanged";

export interface MigrateFileResult {
  source: string;
  actions: MigrateAction[];
}

export interface MigrateResult {
  scanned: number;
  files: Array<{ path: string; actions: MigrateAction[] }>;
}

export interface MigrateOptions {
  /** Explicit root-relative file list — bypasses scan-root filtering entirely. */
  files?: string[];
  /** Compute actions without writing. */
  dryRun?: boolean;
  /** Resolved site/workpiece directory — enables leaf-workspace path normalization. */
  siteDirectory?: string;
}

const HEADER_SCAN_LINES = 120;
const KEY_DECISIONS_MAX_ITEMS = 7;
const TODO_ITEM = "TODO: record current design decisions";

const COMPASS_TAGS = ["MODULE_CONTRACT", "KEY_DECISIONS", "CHANGE_SUMMARY"] as const;
type CompassTag = (typeof COMPASS_TAGS)[number];

const FORBIDDEN_BLOCK_TAGS = ["MODULE_MAP", "keywords", "responsibilities"] as const;
const COMPASS_BLOCK_ANCHOR_RE = /[ \t]*<\/?COMPASS_BLOCK\b[^>]*>[ \t]*/g;

function blockSpan(source: string, tag: string): { start: number; end: number } | null {
  const open = source.indexOf(`<${tag}>`);
  if (open < 0) return null;
  const closeTag = `</${tag}>`;
  const close = source.indexOf(closeTag, open);
  if (close < 0) return null;
  return { start: open, end: close + closeTag.length };
}

function hasUnclosedTag(source: string, tag: string): boolean {
  return source.includes(`<${tag}>`) && !source.includes(`</${tag}>`);
}

function inHeaderRegion(source: string, index: number): boolean {
  return source.slice(0, index).split("\n").length <= HEADER_SCAN_LINES;
}

/** Collect ai-invariant comment texts, deduped, capped, ID-prefix stripped. */
export function collectAiInvariants(source: string, policy: CompassPolicy): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  const re = /@ai-invariant:?\s+([^\n*]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let text = m[1]!.replace(/(-->|\*\/)\s*$/, "").trim();
    // KD-05: seeded items must not lead with a governance-ID prefix.
    const idMatch = text.match(policy.idPatternPrefix);
    if (idMatch) {
      text = text
        .slice(idMatch[0].length)
        .replace(/^\s*[:—-]\s*/, "")
        .trim();
    }
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
    if (items.length >= KEY_DECISIONS_MAX_ITEMS) break;
  }
  return items;
}

function buildKeyDecisionsBlock(items: string[], filePath: string): string {
  const lines = ["<KEY_DECISIONS>"];
  for (const item of items) {
    lines.push(`  <item>${item}</item>`);
  }
  lines.push("</KEY_DECISIONS>");
  const prefix = getLineCommentPrefix(filePath);
  if (prefix) {
    // New block: every line needs the line-comment prefix (unlike block
    // replacement where the first line already carries one).
    return lines.map((line) => prefix + line).join("\n");
  }
  return lines.join("\n");
}

function extractPurposeText(source: string): string {
  const contract = blockSpan(source, "MODULE_CONTRACT");
  if (!contract) return "";
  const contractText = source.slice(contract.start, contract.end);
  const purposeMatch = contractText.match(/<purpose>([\s\S]*?)<\/purpose>/);
  return purposeMatch ? purposeMatch[1]!.replace(/<[^>]+>/g, " ").trim() : "";
}

/**
 * Pure v1 to v2 transform of one file's source. Returns the rewritten source
 * and the closed action union. `unchanged` is exclusive; every other action
 * may combine. Never throws on malformed input — reports `unparseable`.
 */
export function migrateFile(
  source: string,
  policy: CompassPolicy,
  pathFromRoot: string,
  workspaceRelativePath: string,
): MigrateFileResult {
  const actions: MigrateAction[] = [];

  // 1. Header detection — a Compass header lives in the header region only.
  const mcIndex = source.indexOf("<MODULE_CONTRACT>");
  const csIndex = source.indexOf("<CHANGE_SUMMARY>");
  const hasHeader =
    (mcIndex >= 0 && inHeaderRegion(source, mcIndex)) ||
    (csIndex >= 0 && inHeaderRegion(source, csIndex));
  if (!hasHeader) {
    return { source, actions: ["no-header"] };
  }

  // 2. Parseability — an open tag without its close is a broken header.
  for (const tag of COMPASS_TAGS) {
    if (hasUnclosedTag(source, tag)) {
      return { source, actions: ["unparseable"] };
    }
  }

  let next = source;

  // 3. Collapse CHANGE_SUMMARY — same repair semantics as compass.summary.trim.
  const csSpan = blockSpan(next, "CHANGE_SUMMARY");
  if (csSpan) {
    const block = next.slice(csSpan.start, csSpan.end);
    const { items, historyIds } = parseChangeSummary(block);
    const idItems = items.filter((item) => policy.idPatternPrefix.test(item));
    const collapsedIds: string[] = [];
    while (idItems.length > CHANGE_SUMMARY_WINDOW) {
      const oldest = idItems.shift()!;
      const idMatch = oldest.match(policy.idPatternPrefix);
      if (idMatch) collapsedIds.push(idMatch[0]);
    }
    const nextHistory = mergeHistoryIds(historyIds, collapsedIds, policy);
    const changed =
      idItems.length !== items.length ||
      collapsedIds.length > 0 ||
      nextHistory.length !== historyIds.length ||
      nextHistory.some((id, i) => id !== historyIds[i]);
    if (changed) {
      const newBlock = buildChangeSummaryBlock(idItems, nextHistory, pathFromRoot);
      next = next.slice(0, csSpan.start) + newBlock + next.slice(csSpan.end);
      actions.push("collapsed");
    }
  }

  // 4. Strip forbidden v1 blocks and COMPASS_BLOCK anchors.
  let stripped = next;
  for (const tag of FORBIDDEN_BLOCK_TAGS) {
    const tagRe = new RegExp(`[ \\t]*<${tag}>[\\s\\S]*?</${tag}>[ \\t]*`, "g");
    stripped = stripped.replace(tagRe, "");
  }
  stripped = stripped.replace(COMPASS_BLOCK_ANCHOR_RE, "");
  if (stripped !== next) {
    next = stripped;
    actions.push("stripped");
  }

  // 5. Seed KEY_DECISIONS on medium/high-risk files that lack the block.
  const riskClass = detectRiskClass(pathFromRoot, workspaceRelativePath, policy);
  const kdRequired = riskClass === "medium" || riskClass === "high";
  if (kdRequired && !next.includes("<KEY_DECISIONS>")) {
    const invariants = collectAiInvariants(next, policy);
    const items = invariants.length > 0 ? invariants : [TODO_ITEM];
    const kdBlock = buildKeyDecisionsBlock(items, pathFromRoot);
    const mcSpan = blockSpan(next, "MODULE_CONTRACT");
    if (mcSpan) {
      next = next.slice(0, mcSpan.end) + "\n" + kdBlock + next.slice(mcSpan.end);
    } else {
      const csSpan2 = blockSpan(next, "CHANGE_SUMMARY");
      if (csSpan2) {
        next = next.slice(0, csSpan2.start) + kdBlock + "\n" + next.slice(csSpan2.start);
      }
    }
    actions.push(invariants.length > 0 ? "seeded" : "todo");
  }

  // 6. Reorder blocks to canonical order — only when the region between the
  // outermost blocks is whitespace and the blocks themselves.
  const spans = COMPASS_TAGS.map((tag) => ({ tag, span: blockSpan(next, tag) }))
    .filter(
      (entry): entry is { tag: CompassTag; span: { start: number; end: number } } =>
        entry.span !== null,
    )
    .sort((a, b) => a.span.start - b.span.start);
  if (spans.length >= 2) {
    const canonicalOrder = spans
      .slice()
      .sort((a, b) => COMPASS_TAGS.indexOf(a.tag) - COMPASS_TAGS.indexOf(b.tag))
      .map((entry) => entry.tag);
    const currentOrder = spans.map((entry) => entry.tag);
    const outOfOrder = currentOrder.some((tag, i) => tag !== canonicalOrder[i]);
    if (outOfOrder) {
      const minStart = Math.min(...spans.map((entry) => entry.span.start));
      const maxEnd = Math.max(...spans.map((entry) => entry.span.end));
      const region = next.slice(minStart, maxEnd);
      const residue = region
        .replace(/<MODULE_CONTRACT>[\s\S]*?<\/MODULE_CONTRACT>/, "")
        .replace(/<KEY_DECISIONS>[\s\S]*?<\/KEY_DECISIONS>/, "")
        .replace(/<CHANGE_SUMMARY>[\s\S]*?<\/CHANGE_SUMMARY>/, "");
      if (residue.trim().length === 0) {
        const ordered = canonicalOrder.map((tag) => {
          const span = spans.find((entry) => entry.tag === tag)!.span;
          return next.slice(span.start, span.end);
        });
        next = next.slice(0, minStart) + ordered.join("\n") + next.slice(maxEnd);
        actions.push("reordered");
      }
    }
  }

  // 7. Flag boilerplate purpose — report only, the sweep rewrites the text.
  const purposeText = extractPurposeText(next);
  if (
    purposeText.length > 0 &&
    policy.purposeBoilerplatePatterns.some((pattern) => pattern.test(purposeText))
  ) {
    actions.push("purpose-flagged");
  }

  if (actions.length === 0 || next === source) {
    const reportOnly = actions.filter((a) => a === "purpose-flagged");
    return {
      source,
      actions: reportOnly.length > 0 ? reportOnly : ["unchanged"],
    };
  }

  return { source: next, actions };
}

interface MigrateTarget {
  absPath: string;
  pathFromRoot: string;
  workspaceRelativePath: string;
}

function toTarget(workspaceRoot: string, absPath: string, policy: CompassPolicy): MigrateTarget {
  const pathFromRoot = relative(workspaceRoot, absPath).replace(/\\/g, "/");
  const segments = getRelativeSegments(absPath, workspaceRoot);
  const workspaceRelativePath = getWorkspaceRelativeSegments(segments, policy).join("/");
  return { absPath, pathFromRoot, workspaceRelativePath };
}

/**
 * Walk the workspace (or an explicit file list) and apply migrateFile to every
 * authored file. Writes via writeFileIfChanged unless dryRun.
 */
export async function migrateWorkspace(
  workspaceRoot: string,
  input: ForgeCommandInput,
  scanRoot: string | undefined,
  policy: CompassPolicy,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const result: MigrateResult = { scanned: 0, files: [] };

  if (options.files && options.files.length > 0) {
    for (const file of options.files) {
      const absPath = resolve(scanRoot ?? workspaceRoot, file);
      const target = toTarget(workspaceRoot, absPath, policy);
      let source: string;
      try {
        source = await readFile(absPath, "utf8");
      } catch {
        result.files.push({ path: file, actions: ["unparseable"] });
        continue;
      }
      result.scanned += 1;
      const migrated = migrateFile(
        source,
        policy,
        target.pathFromRoot,
        target.workspaceRelativePath,
      );
      result.files.push({ path: target.pathFromRoot, actions: migrated.actions });
      if (!options.dryRun && migrated.source !== source) {
        await writeFileIfChanged(absPath, migrated.source);
      }
    }
    return result;
  }
  const entries = await createCompassInventoryEntries(
    workspaceRoot,
    input,
    scanRoot,
    policy,
    options.siteDirectory,
  );
  for (const entry of entries) {
    if (entry.authoringStatus !== "authored") continue;
    result.scanned += 1;
    const absPath = resolve(workspaceRoot, entry.path);
    const source = getEntrySource(entry) ?? (await readFile(absPath, "utf8"));
    const segments = getRelativeSegments(absPath, workspaceRoot);
    const workspaceRelativePath = getWorkspaceRelativeSegments(segments, policy).join("/");
    const migrated = migrateFile(source, policy, entry.path, workspaceRelativePath);
    result.files.push({ path: entry.path, actions: migrated.actions });
    if (!options.dryRun && migrated.source !== source) {
      await writeFileIfChanged(absPath, migrated.source);
    }
  }

  return result;
}
