/*
<MODULE_CONTRACT>
<purpose>
compass.header.scaffold — pure codemod core (RFC-1318). Authors and repairs
Compass v2 headers under machine-enforced invariants: append-only merge of
existing content, closed-block guarantee on every emission, derived-or-sentinel
purposes, fixture-string safety, header-scoped comment anchors, high-risk
deference, deterministic repair of known malformation shapes.
</purpose>
<non-goals>
  <item>Do not walk the filesystem or write — the handler owns discovery, dirty-target checks, and writes.</item>
  <item>Do not rewrite surviving authored content — the merge only inserts missing blocks/items; weak prose stays for agents.</item>
  <item>Do not strip forbidden v1 blocks or reorder blocks — compass.migrate owns the transformer role.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1318: add compass.header.scaffold codemod for mechanical header sweeps</item>
</CHANGE_SUMMARY>
*/

import type { CompassPolicy, CompassRiskClass } from "../policy.ts";
import {
  COMPASS_TAGS,
  TODO_ITEM,
  blockSpan,
  collectAiInvariants,
  hasUnclosedTag,
  inHeaderRegion,
} from "./compass-migrate.ts";
import {
  EXPORTED_SYMBOL_RE,
  deriveFileTokens,
  getRelativeSegments,
  getWorkspaceRelativeSegments,
} from "./compass-inventory.ts";
import { getLineCommentPrefix } from "./summary-record.ts";

export type ScaffoldDisposition = "inserted" | "repaired" | "sentinel" | "unchanged" | "skipped";

export interface ScaffoldDiagnostic {
  ruleId: "SCAFFOLD-01" | "SCAFFOLD-02";
  message: string;
}

export interface ScaffoldFileResult {
  disposition: ScaffoldDisposition;
  source: string;
  repairs: string[];
  diagnostic?: ScaffoldDiagnostic;
  skipReason?: string;
}

export interface ScaffoldFileInput {
  pathFromRoot: string;
  workspaceRelativePath: string;
  source: string;
  riskClass: CompassRiskClass;
  keyDecisionsRequired: boolean;
  isTest: boolean;
}

const SENTINEL_PURPOSE =
  "TODO(compass): describe this file's role — automatic derivation found no usable signal.";
const SENTINEL_NONGOAL = "TODO(compass): record the boundary this file must not take on.";
const TAG_LINE_CAP = 10;

type CommentStyle = "block" | "html" | "line";

/**
 * Comment styles a file type may carry, most likely first. .astro headers
 * exist in both forms — `/* *\u002f` inside the `---` frontmatter and
 * `<!-- -->` in the markup below — so both are candidates at detection time.
 */
function commentStyleCandidates(path: string): CommentStyle[] {
  if (path.endsWith(".astro")) return ["block", "html"];
  if (path.endsWith(".md")) return ["html"];
  if (getLineCommentPrefix(path) !== null) return ["line"];
  return ["block"];
}

function commentStyleFor(path: string): CommentStyle {
  return commentStyleCandidates(path)[0]!;
}

interface HeaderSpan {
  start: number;
  /** Offset just past the comment terminator. */
  end: number;
  /** Offset of the comment terminator itself (where insertions anchor). */
  closeStart: number;
  style: CommentStyle;
}

function firstTagIndex(source: string): number {
  let best = -1;
  for (const tag of COMPASS_TAGS) {
    const i = source.indexOf(`<${tag}>`);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/**
 * Locate the comment that carries the Compass header — the comment whose open
 * precedes the first compass tag in the header region without a close between
 * them. Repair anchors at the header comment's own terminator, never a close
 * marker below it (fixture blocks or later comments must not absorb the boundary).
 */
function findHeaderSpanInStyle(
  source: string,
  tagIdx: number,
  style: CommentStyle,
  path: string,
): HeaderSpan | null {
  if (style === "block") {
    const open = source.lastIndexOf("/*", tagIdx);
    if (open < 0) return null;
    if (source.slice(open, tagIdx).includes("*/")) return null;
    const close = source.indexOf("*/", tagIdx);
    if (close < 0) return null;
    return { start: open, end: close + 2, closeStart: close, style };
  }
  if (style === "html") {
    const open = source.lastIndexOf("<!--", tagIdx);
    if (open < 0) return null;
    if (source.slice(open, tagIdx).includes("-->")) return null;
    const close = source.indexOf("-->", tagIdx);
    if (close < 0) return null;
    return { start: open, end: close + 3, closeStart: close, style };
  }

  // line style — a contiguous run of prefixed lines around the tag's line.
  const prefix = (getLineCommentPrefix(path) ?? "# ").trimEnd();
  const lines = source.split("\n");
  const offsets: number[] = [];
  let off = 0;
  for (const line of lines) {
    offsets.push(off);
    off += line.length + 1;
  }
  let tagLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (offsets[i]! <= tagIdx && tagIdx < offsets[i]! + lines[i]!.length + 1) {
      tagLine = i;
      break;
    }
  }
  if (tagLine < 0 || !lines[tagLine]!.trimStart().startsWith(prefix)) return null;
  let first = tagLine;
  while (first > 0 && lines[first - 1]!.trimStart().startsWith(prefix)) first -= 1;
  let last = tagLine;
  while (last + 1 < lines.length && lines[last + 1]!.trimStart().startsWith(prefix)) last += 1;
  const end = offsets[last]! + lines[last]!.length;
  return { start: offsets[first]!, end, closeStart: end, style };
}

function findHeaderSpan(source: string, path: string): HeaderSpan | null {
  const tagIdx = firstTagIndex(source);
  if (tagIdx < 0 || !inHeaderRegion(source, tagIdx)) return null;
  for (const style of commentStyleCandidates(path)) {
    const span = findHeaderSpanInStyle(source, tagIdx, style, path);
    if (span) return span;
  }
  return null;
}

/** Lines carrying literal compass tags — the SCAFFOLD-01 evidence list. */
function tagLines(source: string): string[] {
  const out: string[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (/<\/?(?:MODULE_CONTRACT|KEY_DECISIONS|CHANGE_SUMMARY|non-goals|purpose)\b/.test(line)) {
      out.push(`L${index + 1}: ${line.trim().slice(0, 120)}`);
      if (out.length >= TAG_LINE_CAP) break;
    }
  }
  return out;
}

function firstDescribeTitle(source: string): string | undefined {
  return /\bdescribe(?:\.(?:skip|only|todo|each|concurrent|runIf|skipIf))?\s*\(\s*["'`]([^"'`]+)["'`]/.exec(
    source,
  )?.[1];
}

function exportedSymbols(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(EXPORTED_SYMBOL_RE)) names.push(m[1]!);
  return names;
}

function stemPhrase(path: string): string {
  const filename = path.split("/").filter(Boolean).pop() ?? "";
  const dot = filename.lastIndexOf(".");
  const raw = dot > 0 ? filename.slice(0, dot) : filename;
  return raw
    .replace(/\.(test|spec)$/i, "")
    .replace(/[-_.]+/g, " ")
    .trim();
}

/** The PURPOSE-02 bar: ≥10 words and ≥1 file-derived token in the text. */
function purposeMeetsBar(text: string, tokens: Set<string>): boolean {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length < 10) return false;
  const wordSet = new Set(words);
  return [...tokens].some((t) => wordSet.has(t));
}

function derivePurpose(input: ScaffoldFileInput): { text: string; sentinel: boolean } {
  const { pathFromRoot, source, isTest } = input;
  const tokens = deriveFileTokens(pathFromRoot, source);
  const stem = stemPhrase(pathFromRoot);

  if (isTest) {
    const title = firstDescribeTitle(source);
    if (title) {
      const text = `Unit tests for ${title} — covers the ${stem} suite surface and its observable contract.`;
      if (purposeMeetsBar(text, tokens)) return { text, sentinel: false };
    }
  } else {
    const symbols = exportedSymbols(source).slice(0, 3);
    if (symbols.length > 0) {
      const text = `Provides ${symbols.join(", ")} for the ${stem} module surface consumed by callers of this layer.`;
      if (purposeMeetsBar(text, tokens)) return { text, sentinel: false };
    }
  }
  return { text: SENTINEL_PURPOSE, sentinel: true };
}

function contractBlock(purposeText: string, nonGoalItems: string[]): string {
  const goals = nonGoalItems.map((item) => `  <item>${item}</item>`).join("\n");
  return [
    "<MODULE_CONTRACT>",
    `<purpose>${purposeText}</purpose>`,
    "<non-goals>",
    goals,
    "</non-goals>",
    "</MODULE_CONTRACT>",
  ].join("\n");
}

function keyDecisionsBlock(items: string[], path: string): string {
  const prefix = getLineCommentPrefix(path);
  const lines = ["<KEY_DECISIONS>", ...items.map((i) => `  <item>${i}</item>`), "</KEY_DECISIONS>"];
  return prefix ? lines.map((l) => prefix + l).join("\n") : lines.join("\n");
}

function wrapHeader(blocks: string[], style: CommentStyle, path: string): string {
  const body = blocks.join("\n");
  if (style === "html") return `<!--\n${body}\n-->`;
  if (style === "line") {
    const prefix = getLineCommentPrefix(path) ?? "# ";
    return body
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
  }
  return `/*\n${body}\n*/`;
}

/** Offset where a new header lands — after BOM, shebang, astro frontmatter, and directive prologue. */
function insertionOffset(source: string, path: string): number {
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1;
  if (source.startsWith("#!", i)) {
    const nl = source.indexOf("\n", i);
    i = nl < 0 ? source.length : nl + 1;
  }
  // .astro headers land inside the frontmatter fence (block comment) when the
  // file has one — `---\n` opens, the header follows it directly.
  if (path.endsWith(".astro") && source.startsWith("---", i)) {
    const openEnd = source.indexOf("\n", i);
    if (openEnd >= 0) return openEnd + 1;
  }
  for (;;) {
    const m = /^[^\S\r\n]*["']use [\w-]+["'][^\S\r\n]*;?[^\S\r\n]*(?:\r?\n|$)/.exec(
      source.slice(i),
    );
    if (!m) break;
    i += m[0].length;
  }
  while (source[i] === "\n" || source[i] === "\r") i += 1;
  return i;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function skipped(
  reason: string,
  source: string,
  diagnostic?: ScaffoldDiagnostic,
): ScaffoldFileResult {
  return {
    disposition: "skipped",
    source,
    repairs: [],
    skipReason: reason,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/**
 * Pure per-file transform. Returns the (possibly) rewritten source plus a
 * disposition — never throws; unrepairable shapes report SCAFFOLD-02 and the
 * original source.
 */
export function scaffoldFile(input: ScaffoldFileInput, policy: CompassPolicy): ScaffoldFileResult {
  const { source, pathFromRoot, riskClass, keyDecisionsRequired } = input;
  const tagIdx = firstTagIndex(source);
  const span = findHeaderSpan(source, pathFromRoot);

  // Fixture-string safety — markup candidates outside a header comment are
  // string-literal/code-borne tags; dynamic tag construction is agent work.
  if (!span && tagIdx >= 0) {
    const lines = tagLines(source);
    return skipped("fixture-string markup", source, {
      ruleId: "SCAFFOLD-01",
      message: `markup candidates outside a header comment — literal lines: ${lines.join(" | ")}`,
    });
  }

  // High-risk deference — a new header on a high-risk file requires an
  // @ai-invariant the codemod cannot invent; authorship stays agent work.
  const aiInvariants = collectAiInvariants(source, policy);
  if (!span && riskClass === "high" && aiInvariants.length === 0) {
    return skipped(
      "high-risk file requires an @ai-invariant — header authorship stays agent work",
      source,
    );
  }

  // ── Insert path: no header anywhere ───────────────────────────────────────
  if (!span) {
    const purpose = derivePurpose(input);
    const blocks = [
      contractBlock(purpose.text, [SENTINEL_NONGOAL]),
      ...(keyDecisionsRequired
        ? [keyDecisionsBlock(aiInvariants.length > 0 ? aiInvariants : [TODO_ITEM], pathFromRoot)]
        : []),
      "<CHANGE_SUMMARY>\n</CHANGE_SUMMARY>",
    ];
    const header = wrapHeader(blocks, commentStyleFor(pathFromRoot), pathFromRoot);
    const at = insertionOffset(source, pathFromRoot);
    const next = `${source.slice(0, at)}${header}\n\n${source.slice(at)}`;
    if (!closesCleanly(next, pathFromRoot)) {
      return skipped("unrepairable malformation", source, {
        ruleId: "SCAFFOLD-02",
        message: "composed header failed the closed-block parse-back — file left untouched",
      });
    }
    return {
      disposition: purpose.sentinel ? "sentinel" : "inserted",
      source: next,
      repairs: ["inserted-header", ...(purpose.sentinel ? ["sentinel-purpose"] : [])],
    };
  }

  // ── Repair path: append-only merge inside the header comment ──────────────
  // Staged edits: every stage recomputes positions against the post-edit text
  // so coordinates never mix bases.
  let next = source;
  const repairs: string[] = [];
  let usedSentinel = false;
  const linePrefix = () =>
    commentStyleFor(pathFromRoot) === "line" ? (getLineCommentPrefix(pathFromRoot) ?? "# ") : "";
  const reheader = () => {
    const s = findHeaderSpan(next, pathFromRoot);
    return s ? { span: s, text: next.slice(s.start, s.end) } : null;
  };
  const lineWrap = (block: string) =>
    linePrefix() === ""
      ? block
      : block
          .split("\n")
          .map((l) => linePrefix() + l)
          .join("\n");

  // Stage 1 — close any compass tag left open inside the header. The close
  // anchors before the next sibling tag's open (a swallowed sibling) or
  // before the header comment's own terminator.
  {
    const h = reheader();
    if (!h) {
      return skipped("unrepairable malformation", source, {
        ruleId: "SCAFFOLD-02",
        message: "header comment vanished between parse stages — file left untouched",
      });
    }
    const closeEdits: Edit[] = [];
    for (const tag of COMPASS_TAGS) {
      if (!hasUnclosedTag(h.text, tag)) continue;
      const openAt = h.text.indexOf(`<${tag}>`);
      const later = COMPASS_TAGS.slice(COMPASS_TAGS.indexOf(tag) + 1)
        .map((t) => h.text.indexOf(`<${t}>`, openAt + 1))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b);
      const at = later.length > 0 ? later[0]! : h.span.closeStart;
      const closeLine = linePrefix() === "" ? `</${tag}>\n` : `${linePrefix()}</${tag}>\n`;
      closeEdits.push({ start: h.span.start + at, end: h.span.start + at, text: closeLine });
      repairs.push(`closed-${tag.toLowerCase().replace(/_/g, "-")}`);
    }
    next = applyEdits(next, closeEdits);
  }

  // Stage 2 — contract-level repairs: missing contract, missing purpose,
  // missing/unclosed/item-less non-goals.
  {
    const h = reheader()!;
    const edits: Edit[] = [];
    const contract = blockSpan(h.text, "MODULE_CONTRACT");
    if (!contract) {
      // The header comment carries stray tags but no contract — compose one
      // inside the comment before its terminator.
      const purpose = derivePurpose(input);
      usedSentinel = purpose.sentinel;
      const insertion = lineWrap(contractBlock(purpose.text, [SENTINEL_NONGOAL])) + "\n";
      edits.push({ start: h.span.closeStart, end: h.span.closeStart, text: insertion });
      repairs.push("inserted-module-contract");
    } else {
      const contractText = h.text.slice(contract.start, contract.end);
      const base = h.span.start + contract.start;

      if (!contractText.includes("<purpose>")) {
        const purpose = derivePurpose(input);
        usedSentinel = purpose.sentinel;
        const openEnd = base + "<MODULE_CONTRACT>".length;
        edits.push({ start: openEnd, end: openEnd, text: `\n<purpose>${purpose.text}</purpose>` });
        repairs.push(purpose.sentinel ? "sentinel-purpose" : "inserted-purpose");
      }

      const ng = contractText.indexOf("<non-goals>");
      if (ng < 0) {
        const closeAt = base + contractText.indexOf("</MODULE_CONTRACT>");
        edits.push({
          start: closeAt,
          end: closeAt,
          text: `<non-goals>\n  <item>${SENTINEL_NONGOAL}</item>\n</non-goals>\n`,
        });
        repairs.push("inserted-non-goals");
      } else {
        let ngEnd = contractText.indexOf("</non-goals>", ng);
        if (ngEnd < 0) {
          const closeAt = base + contractText.indexOf("</MODULE_CONTRACT>");
          edits.push({ start: closeAt, end: closeAt, text: "</non-goals>\n" });
          repairs.push("closed-non-goals");
          ngEnd = contractText.indexOf("</MODULE_CONTRACT>");
        }
        const inner = contractText.slice(ng + "<non-goals>".length, ngEnd);
        if (!inner.includes("<item>")) {
          const bareLines = inner
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith("*") && !l.startsWith("//"));
          const items = bareLines.length > 0 ? bareLines : [SENTINEL_NONGOAL];
          edits.push({
            start: base + ng + "<non-goals>".length,
            end: base + ngEnd,
            text: `\n${items.map((i) => `  <item>${i}</item>`).join("\n")}\n`,
          });
          repairs.push("non-goals-items");
        }
      }
    }
    next = applyEdits(next, edits);
  }

  // Stage 3 — KEY_DECISIONS required by layer/risk but absent.
  {
    const h = reheader()!;
    if (keyDecisionsRequired && !h.text.includes("<KEY_DECISIONS>")) {
      if (riskClass === "high" && aiInvariants.length === 0) {
        return skipped(
          "high-risk file requires an @ai-invariant — header authorship stays agent work",
          source,
        );
      }
      const kd = lineWrap(
        keyDecisionsBlock(aiInvariants.length > 0 ? aiInvariants : [TODO_ITEM], pathFromRoot),
      );
      const mc = blockSpan(h.text, "MODULE_CONTRACT");
      if (mc) {
        next = applyEdits(next, [
          { start: h.span.start + mc.end, end: h.span.start + mc.end, text: `\n${kd}` },
        ]);
      } else {
        next = applyEdits(next, [
          { start: h.span.closeStart, end: h.span.closeStart, text: `${kd}\n` },
        ]);
      }
      repairs.push("inserted-key-decisions");
    }
  }

  // Stage 4 — CHANGE_SUMMARY absent entirely (unclosed was repaired in stage 1).
  {
    const h = reheader()!;
    if (!h.text.includes("<CHANGE_SUMMARY>")) {
      const cs = lineWrap("<CHANGE_SUMMARY>\n</CHANGE_SUMMARY>");
      const anchor =
        blockSpan(h.text, "KEY_DECISIONS")?.end ?? blockSpan(h.text, "MODULE_CONTRACT")?.end;
      if (anchor !== undefined) {
        next = applyEdits(next, [
          { start: h.span.start + anchor, end: h.span.start + anchor, text: `\n${cs}` },
        ]);
      } else {
        next = applyEdits(next, [
          { start: h.span.closeStart, end: h.span.closeStart, text: `${cs}\n` },
        ]);
      }
      repairs.push("inserted-change-summary");
    }
  }

  if (next === source) {
    return { disposition: "unchanged", source, repairs: [] };
  }
  if (!closesCleanly(next, pathFromRoot)) {
    return skipped("unrepairable malformation", source, {
      ruleId: "SCAFFOLD-02",
      message: "repaired header failed the closed-block parse-back — file left untouched",
    });
  }
  return {
    disposition: usedSentinel ? "sentinel" : "repaired",
    source: next,
    repairs: [...new Set(repairs)],
  };
}

/** Every compass tag present in the header comment closes inside it. */
function closesCleanly(source: string, path: string): boolean {
  const span = findHeaderSpan(source, path);
  if (!span) return false;
  const header = source.slice(span.start, span.end);
  for (const tag of COMPASS_TAGS) {
    if (hasUnclosedTag(header, tag)) return false;
  }
  const contract = blockSpan(header, "MODULE_CONTRACT");
  if (!contract) return false;
  const contractText = header.slice(contract.start, contract.end);
  if (!contractText.includes("<purpose>")) return false;
  const ng = blockSpan(contractText, "non-goals");
  if (!ng) return false;
  const ngText = contractText.slice(ng.start, ng.end);
  if (!ngText.includes("<item>")) return false;
  return header.includes("<CHANGE_SUMMARY>");
}

/** Workspace-relative path for an explicit --files target (mirrors migrate's toTarget). */
export function explicitWorkspaceRelativePath(
  absPath: string,
  workspaceRoot: string,
  policy: CompassPolicy,
): string {
  const segments = getRelativeSegments(absPath, workspaceRoot);
  return getWorkspaceRelativeSegments(segments, policy).join("/");
}
