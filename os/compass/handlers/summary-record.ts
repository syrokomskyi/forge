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
<KEY_DECISIONS>
  <item>The 5-item window collapses oldest-first into history — history holds IDs only, never prose.</item>
  <item>Recording is header-region guarded — a CHANGE_SUMMARY deeper than 120 lines is a doc example, not a header.</item>
  <item>Item text is sanitized on record — literal Compass tags would corrupt history parsing.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1095: summary-record unit tests, commit integration tests, CS rules into compass.validate</item>
  <item>RFC-1095: header-region guard in summary.record, restore test fixture with dynamic tags</item>
  <item>RFC-1097: steps 1-4 — compass.migrate codemod

Add the v1 to v2 Compass header codemod: migrateFile pure transform (collapse, strip, seed, reorder, purpose-flag actions), migrateWorkspace walker, runCompassMigrate handler with dirty-tree refusal and --force/--files/--dry-run flags, module registration, and 15 unit tests.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <history>RFC-1095</history>
</CHANGE_SUMMARY>
*/

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { detectRiskClass, getWorkspaceRelativeSegments } from "./compass-inventory.ts";
import { parseGovernanceIdParts, resolveCompassPolicy, type CompassPolicy } from "../policy.ts";
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

function leadingGovernanceId(item: string, policy: CompassPolicy): string | null {
  const match = item.match(policy.idPattern);
  return match && match.index === 0 ? match[0] : null;
}

/** Merge existing + new history IDs: dedupe, per-namespace ascending numeric order. */
export function mergeHistoryIds(
  existing: string[],
  incoming: string[],
  policy: CompassPolicy,
): string[] {
  const all = [...new Set([...existing, ...incoming])].filter((id) =>
    policy.idPatternFull.test(id),
  );
  return all.sort((a, b) => {
    const pa = parseGovernanceIdParts(a)!;
    const pb = parseGovernanceIdParts(b)!;
    const ns = pa.namespace.localeCompare(pb.namespace);
    return ns !== 0 ? ns : pa.numeric - pb.numeric;
  });
}

export function getLineCommentPrefix(filePath: string): string | null {
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

// Literal Compass block tags inside an item corrupt block parsing — a commit
// message saying "collapsed into history" would be matched by HISTORY_RE and
// produce phantom non-ID tokens (CS-07). Strip the angle brackets on record.
const COMPASS_TAG_LITERAL_RE =
  /<\/?(?:CHANGE_SUMMARY|MODULE_CONTRACT|KEY_DECISIONS|history|item|purpose|non-goals)>/g;

export function sanitizeItemText(text: string): string {
  return text.replace(COMPASS_TAG_LITERAL_RE, (tag) => tag.replace(/[<>]/g, ""));
}

export function isValidGovernanceId(id: string, policy: CompassPolicy): boolean {
  return policy.idPatternFull.test(id);
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
  policy: CompassPolicy,
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
  const newItem = strippedText.length > 0 ? `${id}: ${sanitizeItemText(strippedText)}` : id;
  const normalizedNew = normalizeItemText(newItem);
  if (items.some((item) => normalizeItemText(item) === normalizedNew)) {
    return { recorded: false, collapsed: false, skipReason: "duplicate" };
  }

  const nextItems = [...items, newItem];
  const collapsedIds: string[] = [];
  while (nextItems.length > CHANGE_SUMMARY_WINDOW) {
    const oldest = nextItems.shift()!;
    const oldId = leadingGovernanceId(oldest, policy);
    if (oldId) collapsedIds.push(oldId);
  }
  const collapsed = collapsedIds.length > 0;
  const nextHistory = mergeHistoryIds(historyIds, collapsedIds, policy);

  const newBlock = buildChangeSummaryBlock(nextItems, nextHistory, relPath);
  const transformed = source.replace(CHANGE_SUMMARY_BLOCK_RE, newBlock);
  if (!dryRun && transformed !== source) {
    await writeFileIfChanged(absPath, transformed);
  }
  return { recorded: true, collapsed };
}

function riskReminderNeeded(relPath: string, source: string, policy: CompassPolicy): boolean {
  const segments = relPath.split("/").filter(Boolean);
  const workspaceRel = getWorkspaceRelativeSegments(segments, policy).join("/");
  const risk = detectRiskClass(relPath, workspaceRel, policy);
  return risk === "medium" || risk === "high" || source.includes("<KEY_DECISIONS>");
}

export async function runCompassSummaryRecord(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SummaryRecordResult>> {
  const scanRoot = resolveCompassScanRoot(input, context);
  const baseRoot = scanRoot ?? context.workspaceRoot;
  const policy = resolveCompassPolicy(baseRoot, context.forgeRoot);

  const id = input.flags["id"];
  if (typeof id !== "string" || !isValidGovernanceId(id, policy)) {
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
      const outcome = await recordSummaryItem(absPath, relPath, id, text, context.dryRun, policy);
      if (outcome.skipReason) {
        result.skipped.push({ file, reason: outcome.skipReason });
        continue;
      }
      if (outcome.recorded) {
        result.recorded.push(relPath);
        if (outcome.collapsed) result.collapsed.push(relPath);
        const source = await readFile(absPath, "utf8");
        if (riskReminderNeeded(relPath, source, policy)) {
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
