/*
<MODULE_CONTRACT>
<purpose>compass.summary.record — commit-time append of governance-referencing
items to CHANGE_SUMMARY blocks per RFC-1095. Collapses the 5-item window into
<history>, dedupes by ID+text, and reminds about KEY_DECISIONS on risk files.</purpose>
<non-goals>
  <item>Do not create CHANGE_SUMMARY blocks — headers are authored by fo-compass-annotate.</item>
  <item>Do not validate semantic quality of item text — record writes what the commit declares.</item>
  <item>Do not import @warpgogol/* packages — this handler is autonomous (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1095: initial implementation of compass.summary.record with window collapse and commit integration.</item>
  <item>RFC-1095: compass.summary.record, trim repair rewrite, commit integration</item>
  <item>RFC-1095: summary-record unit tests, commit integration tests, CS rules into compass.validate</item>
  <item>RFC-1095: header-region guard in summary.record, restore test fixture with dynamic tags</item>
</CHANGE_SUMMARY>
*/

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import {
  detectLayer,
  detectRiskClass,
  getWorkspaceRelativeSegments,
  GOVERNANCE_ID_RE,
} from "./compass-inventory.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const CHANGE_SUMMARY_BLOCK_RE = /<CHANGE_SUMMARY>[\s\S]*?<\/CHANGE_SUMMARY>/;
const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;
const HISTORY_RE = /<history>([\s\S]*?)<\/history>/;
const HISTORY_ID_FULL_RE = /^([A-Z][A-Z0-9]*-)+\d+$/;
const HISTORY_ID_PARTS_RE = /^(([A-Z][A-Z0-9]*-)+)(\d+)$/;
const CONVENTIONAL_PREFIX_RE = /^[a-z]+(\([^)]*\))?!?:\s*/i;

export const CHANGE_SUMMARY_WINDOW = 5;

// A CHANGE_SUMMARY block is a file header only when it starts within this many
// lines from the top. Deeper matches are examples inside template literals or
// fenced doc sections, not headers.
const HEADER_SCAN_LINES = 120;

export interface SummaryRecordInput {
  id: string;
  files: string[];
  text?: string;
  workpiece?: string;
}

export type SummaryRecordSkipReason = "no-block" | "duplicate" | "unparseable";

export interface SummaryRecordResult {
  command: "compass.summary.record";
  status: "pass";
  recorded: string[];
  collapsed: string[];
  skipped: Array<{ file: string; reason: SummaryRecordSkipReason }>;
  keyDecisionsReminders: string[];
}

interface ParsedChangeSummary {
  items: string[];
  historyIds: string[];
}

export function parseChangeSummary(block: string): ParsedChangeSummary {
  const items: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(ITEM_RE.source, "g");
  while ((m = re.exec(block)) !== null) {
    items.push(m[1]!.trim());
  }
  const historyMatch = block.match(HISTORY_RE);
  const historyIds = historyMatch
    ? historyMatch[1]!
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  return { items, historyIds };
}

function normalizeItemText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function leadingGovernanceId(item: string): string | null {
  const match = item.match(GOVERNANCE_ID_RE);
  return match && match.index === 0 ? match[0] : null;
}

/** Merge existing + new history IDs: dedupe, per-namespace ascending numeric order. */
export function mergeHistoryIds(existing: string[], incoming: string[]): string[] {
  const all = [...new Set([...existing, ...incoming])].filter((id) => HISTORY_ID_FULL_RE.test(id));
  return all.sort((a, b) => {
    const pa = a.match(HISTORY_ID_PARTS_RE)!;
    const pb = b.match(HISTORY_ID_PARTS_RE)!;
    const ns = pa[1]!.localeCompare(pb[1]!);
    return ns !== 0 ? ns : Number(pa[3]) - Number(pb[3]);
  });
}

function getLineCommentPrefix(filePath: string): string | null {
  if (filePath.endsWith(".gd")) return "# ";
  if (filePath.endsWith(".tscn") || filePath.endsWith(".tres")) return "; ";
  return null;
}

export function buildChangeSummaryBlock(
  items: string[],
  historyIds: string[],
  filePath: string,
): string {
  const prefix = getLineCommentPrefix(filePath);
  const lines = ["<CHANGE_SUMMARY>"];
  for (const item of items) {
    lines.push(`  <item>${item}</item>`);
  }
  if (historyIds.length > 0) {
    lines.push(`  <history>${historyIds.join(", ")}</history>`);
  }
  lines.push("</CHANGE_SUMMARY>");
  if (prefix) {
    return lines.map((line, i) => (i === 0 ? line : prefix + line)).join("\n");
  }
  return lines.join("\n");
}

export function stripConventionalPrefix(subject: string): string {
  return subject.replace(CONVENTIONAL_PREFIX_RE, "").trim();
}

export function isValidGovernanceId(id: string): boolean {
  return new RegExp(`^${GOVERNANCE_ID_RE.source}$`).test(id);
}

interface RecordOutcome {
  recorded: boolean;
  collapsed: boolean;
  skipReason?: SummaryRecordSkipReason;
}

/**
 * Append `ID: text` to one file's CHANGE_SUMMARY and collapse the window.
 * Returns the outcome; writes the file only when mutated and not dry-run.
 */
export async function recordSummaryItem(
  absPath: string,
  relPath: string,
  id: string,
  text: string,
  dryRun: boolean,
): Promise<RecordOutcome> {
  const source = await readFile(absPath, "utf8");
  const blockMatch = source.match(CHANGE_SUMMARY_BLOCK_RE);
  // Header-region guard: a CHANGE_SUMMARY is a header only when it sits at the
  // top of the file. Blocks deeper in the source are examples inside template
  // literals or fenced doc sections — recording into them corrupts the file.
  const inHeaderRegion =
    blockMatch !== null &&
    blockMatch.index !== undefined &&
    source.slice(0, blockMatch.index).split("\n").length <= HEADER_SCAN_LINES;
  if (!blockMatch || !inHeaderRegion) {
    return {
      recorded: false,
      collapsed: false,
      skipReason: source.includes("<CHANGE_SUMMARY>") ? "unparseable" : "no-block",
    };
  }

  const { items, historyIds } = parseChangeSummary(blockMatch[0]);
  // Avoid "RFC-1095: RFC-1095 ..." when the text already leads with the same ID;
  // a text equal to the bare ID collapses to the bare-ID item form.
  const strippedText = text.startsWith(id)
    ? text.slice(id.length).replace(/^\s*[:—-]?\s*/, "")
    : text;
  const newItem = strippedText.length > 0 ? `${id}: ${strippedText}` : id;
  const normalizedNew = normalizeItemText(newItem);
  if (items.some((item) => normalizeItemText(item) === normalizedNew)) {
    return { recorded: false, collapsed: false, skipReason: "duplicate" };
  }

  const nextItems = [...items, newItem];
  const collapsedIds: string[] = [];
  while (nextItems.length > CHANGE_SUMMARY_WINDOW) {
    const oldest = nextItems.shift()!;
    const oldId = leadingGovernanceId(oldest);
    if (oldId) collapsedIds.push(oldId);
  }
  const collapsed = collapsedIds.length > 0;
  const nextHistory = mergeHistoryIds(historyIds, collapsedIds);

  const newBlock = buildChangeSummaryBlock(nextItems, nextHistory, relPath);
  const transformed = source.replace(CHANGE_SUMMARY_BLOCK_RE, newBlock);
  if (!dryRun && transformed !== source) {
    await writeFileIfChanged(absPath, transformed);
  }
  return { recorded: true, collapsed };
}

function riskReminderNeeded(relPath: string, source: string): boolean {
  const segments = relPath.split("/").filter(Boolean);
  const workspaceRel = getWorkspaceRelativeSegments(segments).join("/");
  const layer = detectLayer(workspaceRel);
  const risk = detectRiskClass(relPath, layer);
  return risk === "medium" || risk === "high" || source.includes("<KEY_DECISIONS>");
}

export async function runCompassSummaryRecord(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SummaryRecordResult>> {
  const id = input.flags["id"];
  if (typeof id !== "string" || !isValidGovernanceId(id)) {
    context.logger.error(
      `[compass.summary.record] --id is required and must be a governance ID (e.g. RFC-1095), got: ${String(id)}`,
    );
    return { exitCode: 1, summary: "invalid or missing --id" };
  }

  const rawFiles = input.flags["files"];
  const files = Array.isArray(rawFiles)
    ? rawFiles
    : typeof rawFiles === "string"
      ? rawFiles.split(/\s+/).filter(Boolean)
      : [];

  const rawText = input.flags["text"];
  const text = typeof rawText === "string" && rawText.trim().length > 0 ? rawText.trim() : id;

  const scanRoot = resolveCompassScanRoot(input, context);
  const baseRoot = scanRoot ?? context.workspaceRoot;

  const result: SummaryRecordResult = {
    command: "compass.summary.record",
    status: "pass",
    recorded: [],
    collapsed: [],
    skipped: [],
    keyDecisionsReminders: [],
  };

  for (const file of files) {
    const absPath = resolve(baseRoot, file);
    const relPath = relative(baseRoot, absPath).replace(/\\/g, "/");
    if (!existsSync(absPath)) {
      result.skipped.push({ file, reason: "unparseable" });
      context.logger.warn(`[compass.summary.record] skipped ${file}: file not found`);
      continue;
    }
    try {
      const outcome = await recordSummaryItem(absPath, relPath, id, text, context.dryRun);
      if (outcome.skipReason) {
        result.skipped.push({ file, reason: outcome.skipReason });
        continue;
      }
      if (outcome.recorded) {
        result.recorded.push(relPath);
        if (outcome.collapsed) result.collapsed.push(relPath);
        const source = await readFile(absPath, "utf8");
        if (riskReminderNeeded(relPath, source)) {
          result.keyDecisionsReminders.push(relPath);
          context.logger.warn(`[compass.summary.record] review KEY_DECISIONS in ${relPath}`);
        }
      }
    } catch (err) {
      result.skipped.push({ file, reason: "unparseable" });
      context.logger.warn(
        `[compass.summary.record] skipped ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    data: result,
    exitCode: 0,
    summary: `[compass.summary.record] recorded=${result.recorded.length}, collapsed=${result.collapsed.length}, skipped=${result.skipped.length}`,
  };
}
