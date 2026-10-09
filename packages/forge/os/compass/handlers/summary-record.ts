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
  <item>RFC-1097: AC-4 banned literal in os/compass handlers

compass-migrate-handler hint used a consumer-specific run command — switched to generic 'pnpm exec forge run' convention. Reworded recorded CHANGE_SUMMARY items in 3 handlers to drop the consumer-specific literal. compass-policy AC-4 test green (65/65).</item>
  <item>RFC-1220: step 2 — fail-closed guards in history paths</item>
  <item>RFC-1233: stripGitTrailers at the record point + sanitizeItemText star-slash guard — commit-message trailers (Token: value / Token #value, plus markdown-link attribution lines like "Generated with [X](url)") no longer pollute injected items.</item>
  <item>Session-retro 2026-10-08: id-in-diff dedup — auto-inject skips when the worktree diff already carries a same-ID item (HEAD-vs-worktree via git show HEAD:path), closing the descriptive+generic duplicate class seen on RFC-1237.</item>
  <item>RFC-1249: wire werkstatt.commands.validate into packages.check + retire CMD-OUTPUT debt</item>
  <history>CONTRACT-02, PURPOSE-02, RFC-1095, RFC-1097</history>
</CHANGE_SUMMARY>
*/

import { execFile, existsSync } from "../../../src/utils/sync-fs.ts";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";

import { resolve, relative } from "node:path";
import { detectRiskClass, getWorkspaceRelativeSegments } from "./compass-inventory.ts";
import { parseGovernanceIdParts, resolveCompassPolicy, type CompassPolicy } from "../policy.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;
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

export type SummaryRecordSkipReason = "no-block" | "duplicate" | "unparseable" | "id-in-diff";

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

/**
 * Merge existing + new history IDs: dedupe, per-namespace ascending numeric order.
 * Tokens that pass `idPatternFull` yet fail `parseGovernanceIdParts` (policy/parser
 * drift) are kept appended after the sorted parseable tokens in encounter order —
 * provenance is preserved and the next `compass.validate` emits CS-07 (RFC-1220).
 */
export function mergeHistoryIds(
  existing: string[],
  incoming: string[],
  policy: CompassPolicy,
): string[] {
  const all = [...new Set([...existing, ...incoming])].filter((id) =>
    policy.idPatternFull.test(id),
  );
  const partsById = new Map(all.map((id) => [id, parseGovernanceIdParts(id)]));
  const parseable = all.filter((id) => partsById.get(id) !== null);
  const unparseable = all.filter((id) => partsById.get(id) === null);
  parseable.sort((a, b) => {
    const pa = partsById.get(a)!;
    const pb = partsById.get(b)!;
    const ns = pa.namespace.localeCompare(pb.namespace);
    return ns !== 0 ? ns : pa.numeric - pb.numeric;
  });
  return [...parseable, ...unparseable];
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

// RFC-1233: git-trailer tail block — strict `Token: value` / `Token #value`
// lines (interpret-trailers shape, empty value allowed), plus lines ending
// in a markdown link (the observed "Generated with [X](url)" attribution
// boilerplate has no separator). A link-shaped line is admitted only when
// the block also contains at least one strict trailer line — a lone link
// tail is prose.
const TRAILER_LINE_RE = /^[A-Za-z0-9-]+(:| #)\s*.*$/;
const MARKDOWN_LINK_TAIL_RE = /^.*\[[^\]]*\]\([^)]+\)\s*$/;

/**
 * Remove a trailing git-trailer block: the contiguous tail of strict
 * trailer lines and admitted markdown-link lines. A blank line ends the
 * tail paragraph. Returns the message without the block; when the tail
 * holds no strict trailer line the message is returned unchanged.
 */
export function stripGitTrailers(message: string): string {
  const lines = message.trimEnd().split("\n");
  let start = lines.length;
  let sawStrict = false;
  while (start > 0) {
    const line = lines[start - 1]!.trim();
    if (line === "") break;
    if (TRAILER_LINE_RE.test(line)) {
      sawStrict = true;
      start--;
    } else if (MARKDOWN_LINK_TAIL_RE.test(line)) {
      start--;
    } else {
      break;
    }
  }
  if (!sawStrict || start === lines.length) return message;
  return lines.slice(0, start).join("\n").trimEnd();
}

// Literal Compass block tags inside an item corrupt block parsing — a commit
// message saying "collapsed into history" would be matched by HISTORY_RE and
// produce phantom non-ID tokens (CS-07). Strip the angle brackets on record.
const COMPASS_TAG_LITERAL_RE =
  /<\/?(?:CHANGE_SUMMARY|MODULE_CONTRACT|KEY_DECISIONS|history|item|purpose|non-goals)>/g;

export function sanitizeItemText(text: string): string {
  return (
    text
      .replace(COMPASS_TAG_LITERAL_RE, (tag) => tag.replace(/[<>]/g, ""))
      // RFC-1233: a literal star-slash sequence would terminate the
      // surrounding block comment when the item lands in /* ... */ headers.
      // ∕ (U+2215) is visually near-identical, idempotent, and never re-forms.
      .replace(/\*\//g, "*\u2215")
  );
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
 * `headSource` is the file's content at HEAD (when resolvable) — it enables
 * the id-in-diff dedup; pass undefined outside git workspaces.
 */
export async function recordSummaryItem(
  absPath: string,
  relPath: string,
  id: string,
  text: string,
  dryRun: boolean,
  policy: CompassPolicy,
  headSource?: string,
): Promise<RecordOutcome> {
  const source = await io.readFile(absPath);
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

  // A same-ID item already in the worktree but absent from HEAD means the
  // pending change already carries a hand-authored record for this governance
  // ID — the auto-injected subject-derived item would duplicate it at lower
  // specificity (observed 2026-10-08: 27 files carried descriptive + generic
  // RFC-1237 items). HEAD-resident same-ID items do NOT suppress: consecutive
  // commits under one RFC legitimately stack step items.
  if (headSource !== undefined) {
    const headBlock = headSource.match(CHANGE_SUMMARY_BLOCK_RE);
    const headItems = headBlock ? parseChangeSummary(headBlock[0]).items : [];
    const idInWorktree = items.some((item) => leadingGovernanceId(item, policy) === id);
    const idInHead = headItems.some((item) => leadingGovernanceId(item, policy) === id);
    if (idInWorktree && !idInHead) {
      return { recorded: false, collapsed: false, skipReason: "id-in-diff" };
    }
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

function execGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * Read `path`'s content at HEAD — the baseline for the id-in-diff dedup.
 * Returns undefined when the file is untracked or the workspace is not a git
 * repo (the dedup then falls back to exact-text matching only).
 */
async function readHeadSource(gitTop: string | null, absPath: string): Promise<string | undefined> {
  if (!gitTop) return undefined;
  const rel = relative(gitTop, absPath).replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("..")) return undefined;
  const source = await execGit(gitTop, ["show", `HEAD:${rel}`]);
  return source ?? undefined;
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
  const io = resolveIo(context.io);
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
  // RFC-1233: strip the git-trailer block at the single injection point —
  // ecosystem.commit and mission.git.commit both pipe the raw message here.
  const stripped = typeof rawText === "string" ? stripGitTrailers(rawText).trim() : "";
  const text = stripped.length > 0 ? stripped : id;

  const result: SummaryRecordResult = {
    command: "compass.summary.record",
    status: "pass",
    recorded: [],
    collapsed: [],
    skipped: [],
    keyDecisionsReminders: [],
  };

  const gitTopRaw = await execGit(baseRoot, ["rev-parse", "--show-toplevel"]);
  const gitTop = gitTopRaw?.trim() || null;

  for (const file of files) {
    const absPath = resolve(baseRoot, file);
    const relPath = relative(baseRoot, absPath).replace(/\\/g, "/");
    if (!existsSync(absPath)) {
      result.skipped.push({ file, reason: "unparseable" });
      context.logger.warn(`[compass.summary.record] skipped ${file}: file not found`);
      continue;
    }
    try {
      const headSource = await readHeadSource(gitTop, absPath);
      const outcome = await recordSummaryItem(
        absPath,
        relPath,
        id,
        text,
        context.dryRun,
        policy,
        headSource,
      );
      if (outcome.skipReason) {
        result.skipped.push({ file, reason: outcome.skipReason });
        continue;
      }
      if (outcome.recorded) {
        result.recorded.push(relPath);
        if (outcome.collapsed) result.collapsed.push(relPath);
        const source = await io.readFile(absPath);
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
