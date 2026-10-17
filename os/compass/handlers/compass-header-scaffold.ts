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
  <item>RFC-1318</item>
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
/**
 * A comment opener counts as a header carrier only when nothing but
 * whitespace precedes it on its line — an opener inside a string literal or
 * mid-expression is fixture material, not a comment (SCAFFOLD-01).
 */
function atLineStart(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return source.slice(lineStart, index).trim() === "";
}

/**
 * Line-start openers still sit inside fixtures when they live inside a
 * multi-line template literal (odd unescaped-backtick count) or a fenced
 * code block (odd ```-fence count) — neither is a real comment.
 */
function insideLiteral(source: string, open: number, style: CommentStyle): boolean {
  const before = source.slice(0, open);
  if (style === "block") {
    return (before.match(/(?<!\\)`/g) ?? []).length % 2 === 1;
  }
  if (style === "html") {
    const fences = before
      .split("\n")
      .filter((l) => l.trimStart().startsWith("```") || l.trimStart().startsWith("~~~")).length;
    return fences % 2 === 1;
  }
  if (style === "line") {
    // GDScript/tres docstrings: an odd triple-quote count puts the run inside
    // a string literal, not a comment block.
    return (before.match(/"""/g) ?? []).length % 2 === 1;
  }
  return false;
}

function findHeaderSpanInStyle(
  source: string,
  tagIdx: number,
  style: CommentStyle,
  path: string,
): HeaderSpan | null {
  if (style === "block") {
    const open = source.lastIndexOf("/*", tagIdx);
    if (open < 0 || !atLineStart(source, open) || insideLiteral(source, open, style)) return null;
    if (source.slice(open, tagIdx).includes("*/")) return null;
    const close = source.indexOf("*/", tagIdx);
    if (close < 0) return null;
    return { start: open, end: close + 2, closeStart: close, style };
  }
  if (style === "html") {
    const open = source.lastIndexOf("<!--", tagIdx);
    if (open < 0 || !atLineStart(source, open) || insideLiteral(source, open, style)) return null;
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
  if (insideLiteral(source, offsets[first]!, style)) return null;
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
    .replace(/[[\]]/g, " ")
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
      const clean = title.replace(/[<>]/g, "");
      const text = `Unit tests for ${clean} — covers the ${stem} suite surface and its observable contract.`;
      if (purposeMeetsBar(text, tokens)) return { text, sentinel: false };
    }
  } else {
    const symbols = exportedSymbols(source)
      .slice(0, 3)
      .map((s) => s.replace(/[<>]/g, ""));
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

function keyDecisionsBlock(items: string[]): string {
  return ["<KEY_DECISIONS>", ...items.map((i) => `  <item>${i}</item>`), "</KEY_DECISIONS>"].join(
    "\n",
  );
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

/**
 * Comment style for a NEW header. .astro gets `/* *\u002f` inside a `---`
 * frontmatter fence but `<!-- -->` when the file has none — literal block
 * markers in the template region would render as text.
 */
function insertStyleFor(path: string, source: string): CommentStyle {
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (path.endsWith(".astro") && !source.startsWith("---", start)) return "html";
  return commentStyleFor(path);
}

/**
 * Offset where a new header lands — after BOM, shebang, astro frontmatter,
 * markdown YAML frontmatter, and directive prologue. For .astro the offset is
 * INSIDE the frontmatter fence (block comment); for .md it is after the fence
 * (frontmatter stays first, then the `<!-- -->` header).
 */
function insertionOffset(source: string, path: string): number {
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1;
  if (source.startsWith("#!", i)) {
    const nl = source.indexOf("\n", i);
    i = nl < 0 ? source.length : nl + 1;
  }
  if (path.endsWith(".astro") && source.startsWith("---", i)) {
    const openEnd = source.indexOf("\n", i);
    if (openEnd >= 0) return openEnd + 1;
  }
  if (path.endsWith(".md") && source.startsWith("---", i)) {
    // The closing fence must be a --- only line — `----` rules or body
    // horizontal rules are not frontmatter terminators.
    const close = source.slice(i + 3).search(/\r?\n---[^\S\r\n]*(?:\r?\n|$)/);
    if (close >= 0) {
      const nlLen = source[i + 3 + close] === "\r" ? 2 : 1;
      const fenceStart = i + 3 + close + nlLen;
      const afterClose = source.indexOf("\n", fenceStart);
      i = afterClose < 0 ? source.length : afterClose + 1;
    }
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

/** Offset of the start of the line containing `index`. */
function lineStartOf(source: string, index: number): number {
  return source.lastIndexOf("\n", index - 1) + 1;
}

interface Edit {
  start: number;
  end: number;
  text: string;
  /**
   * Emission rank for same-position inserts — higher applies first so the
   * final text order follows ascending rank (inner closes before new blocks
   * before outer closes at a shared anchor).
   */
  order?: number;
}

function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || (b.order ?? 0) - (a.order ?? 0));
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
  // An unterminated comment opener swallowing the tags is a malformation
  // (SCAFFOLD-02), not a fixture.
  if (!span && tagIdx >= 0) {
    const unterminated = (
      [
        ["/*", "*/"],
        ["<!--", "-->"],
      ] as const
    ).some(([opener, closer]) => {
      const open = source.lastIndexOf(opener, tagIdx);
      return (
        open >= 0 &&
        atLineStart(source, open) &&
        !insideLiteral(source, open, opener === "/*" ? "block" : "html") &&
        !source.slice(open, tagIdx).includes(closer) &&
        source.indexOf(closer, tagIdx) < 0
      );
    });
    if (unterminated) {
      return skipped("unrepairable malformation", source, {
        ruleId: "SCAFFOLD-02",
        message: "unterminated comment carries compass tags — file left untouched",
      });
    }
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
        ? [keyDecisionsBlock(aiInvariants.length > 0 ? aiInvariants : [TODO_ITEM])]
        : []),
      "<CHANGE_SUMMARY>\n</CHANGE_SUMMARY>",
    ];
    const style = insertStyleFor(pathFromRoot, source);
    const header = wrapHeader(blocks, style, pathFromRoot);
    const at = insertionOffset(source, pathFromRoot);
    // Never glue the header onto a partial last line (EOF shebang, frontmatter
    // fence without trailing newline, terminal 'use client').
    const pad = at > 0 && source[at - 1] !== "\n" ? "\n" : "";
    const next = `${source.slice(0, at)}${pad}${header}\n\n${source.slice(at)}`;
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
  const prefixFor = (s: HeaderSpan) =>
    s.style === "line" ? (getLineCommentPrefix(pathFromRoot) ?? "# ") : "";
  const reheader = () => {
    const s = findHeaderSpan(next, pathFromRoot);
    return s ? { span: s, text: next.slice(s.start, s.end) } : null;
  };
  const lineWrap = (block: string, s: HeaderSpan) => {
    const prefix = prefixFor(s);
    return prefix === ""
      ? block
      : block
          .split("\n")
          .map((l) => prefix + l)
          .join("\n");
  };
  // Line-style spans may only be edited at line boundaries — a mid-line
  // insert either splits the prefix run or glues text onto a comment line.
  // insertAt: before the line containing absPos. appendAt: past the run's
  // end for line style (closeStart === end there), before the comment
  // terminator otherwise. Line-style text needs a leading "\n".
  const insertAt = (absPos: number, h: { span: HeaderSpan }) =>
    prefixFor(h.span) !== "" ? lineStartOf(next, absPos) : absPos;
  const appendAt = (h: { span: HeaderSpan }) =>
    prefixFor(h.span) !== "" ? h.span.end : h.span.closeStart;
  const appendText = (block: string, s: HeaderSpan) =>
    prefixFor(s) !== "" ? `\n${block}` : `${block}\n`;
  const stageGuard = (): ScaffoldFileResult => ({
    disposition: "skipped",
    source,
    repairs: [],
    skipReason: "unrepairable malformation",
    diagnostic: {
      ruleId: "SCAFFOLD-02",
      message: "header comment lost between repair stages — file left untouched",
    },
  });

  // Stage 1 — close any compass tag left open inside the header. The close
  // anchors before the next sibling tag's open (a swallowed sibling) or
  // before the header comment's own terminator. All anchor positions are
  // header-relative and shift by h.span.start exactly once.
  {
    const h = reheader();
    if (!h) return stageGuard();
    const prefix = prefixFor(h.span);
    const closeEdits: Edit[] = [];
    for (const tag of COMPASS_TAGS) {
      if (!hasUnclosedTag(h.text, tag)) continue;
      const openAt = h.text.indexOf(`<${tag}>`);
      const later = COMPASS_TAGS.slice(COMPASS_TAGS.indexOf(tag) + 1)
        .map((t) => h.text.indexOf(`<${t}>`, openAt + 1))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b);
      let at: number;
      let closeLine: string;
      if (later.length > 0 && prefix !== "") {
        // Anchor at the sibling tag's line start — a mid-line insert would
        // split the contiguous prefix run line comments depend on.
        at = h.text.lastIndexOf("\n", later[0]! - 1) + 1;
        closeLine = `${prefix}</${tag}>\n`;
      } else if (later.length > 0) {
        at = later[0]!;
        closeLine = `</${tag}>\n`;
      } else if (prefix !== "") {
        // End of the prefix run — open a fresh line rather than gluing onto
        // the last comment line's tail.
        at = h.span.end - h.span.start;
        closeLine = `\n${prefix}</${tag}>`;
      } else {
        at = h.span.closeStart - h.span.start;
        closeLine = `</${tag}>\n`;
      }
      closeEdits.push({ start: h.span.start + at, end: h.span.start + at, text: closeLine });
      repairs.push(`closed-${tag.toLowerCase().replace(/_/g, "-")}`);
    }
    next = applyEdits(next, closeEdits);
  }

  // Stage 2 — contract-level repairs: missing contract, missing/unclosed
  // purpose, missing/unclosed/item-less non-goals.
  {
    const h = reheader();
    if (!h) return stageGuard();
    const edits: Edit[] = [];
    const contract = blockSpan(h.text, "MODULE_CONTRACT");
    if (!contract) {
      // The header comment carries stray tags but no contract — compose one
      // inside the comment. Canonical order puts MODULE_CONTRACT first, so it
      // anchors before the earliest stray block (or at the run's end).
      const purpose = derivePurpose(input);
      usedSentinel = purpose.sentinel;
      const insertion = lineWrap(contractBlock(purpose.text, [SENTINEL_NONGOAL]), h.span);
      const strayIdx = ["<KEY_DECISIONS>", "<CHANGE_SUMMARY>"]
        .map((t) => h.text.indexOf(t))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0];
      if (strayIdx !== undefined) {
        const at = insertAt(h.span.start + strayIdx, h);
        edits.push({ start: at, end: at, text: `${insertion}\n` });
      } else {
        const at = appendAt(h);
        edits.push({ start: at, end: at, text: appendText(insertion, h.span) });
      }
      repairs.push("inserted-module-contract");
    } else {
      const contractText = h.text.slice(contract.start, contract.end);
      const base = h.span.start + contract.start;

      if (!contractText.includes("<purpose>")) {
        const purpose = derivePurpose(input);
        usedSentinel = purpose.sentinel;
        const openEnd = base + "<MODULE_CONTRACT>".length;
        edits.push({
          start: openEnd,
          end: openEnd,
          text: `\n${lineWrap(`<purpose>${purpose.text}</purpose>`, h.span)}`,
          order: 20,
        });
        repairs.push(purpose.sentinel ? "sentinel-purpose" : "inserted-purpose");
      } else if (!contractText.includes("</purpose>")) {
        // An unclosed <purpose> swallows its siblings — close it before the
        // next inner tag or the contract close, whichever comes first.
        const purposeOpen = contractText.indexOf("<purpose>");
        const following = ["<non-goals>", "</MODULE_CONTRACT>"]
          .map((t) => contractText.indexOf(t, purposeOpen + 1))
          .filter((i) => i >= 0)
          .sort((a, b) => a - b);
        // `following` is contractText-relative; contract.end is h.text-relative.
        const absAt = following.length > 0 ? base + following[0]! : h.span.start + contract.end;
        // Same-line siblings (`# <purpose>t <non-goals>`) close inline —
        // a line-start insert would emit the close before its own open and
        // a prefixed insert would split the line leaving a bare tag tail.
        const purposeAbs = base + purposeOpen;
        const sameLine =
          prefixFor(h.span) !== "" && lineStartOf(next, absAt) === lineStartOf(next, purposeAbs);
        const anchor = sameLine ? absAt : insertAt(absAt, h);
        edits.push({
          start: anchor,
          end: anchor,
          text: sameLine ? `</purpose> ` : `${lineWrap("</purpose>", h.span)}\n`,
          order: 10,
        });
        repairs.push("closed-purpose");
      }

      const ng = contractText.indexOf("<non-goals>");
      if (ng < 0) {
        const anchor = insertAt(base + contractText.indexOf("</MODULE_CONTRACT>"), h);
        edits.push({
          start: anchor,
          end: anchor,
          text: `${lineWrap(`<non-goals>\n  <item>${SENTINEL_NONGOAL}</item>\n</non-goals>`, h.span)}\n`,
          order: 30,
        });
        repairs.push("inserted-non-goals");
      } else {
        let ngEnd = contractText.indexOf("</non-goals>", ng);
        if (ngEnd < 0) {
          const anchor = insertAt(base + contractText.indexOf("</MODULE_CONTRACT>"), h);
          edits.push({
            start: anchor,
            end: anchor,
            text: `${lineWrap("</non-goals>", h.span)}\n`,
            order: 40,
          });
          repairs.push("closed-non-goals");
          ngEnd = contractText.indexOf("</MODULE_CONTRACT>");
        }
        const inner = contractText.slice(ng + "<non-goals>".length, ngEnd);
        const itemOpens = (inner.match(/<item>/g) ?? []).length;
        const itemCloses = (inner.match(/<\/item>/g) ?? []).length;
        if (itemOpens === 0) {
          const bareLines = inner
            .split("\n")
            .map((l) => l.trim().replace(/^[#;]+\s?/, ""))
            .filter((l) => l.length > 0 && !l.startsWith("*") && !l.startsWith("//"));
          const items = bareLines.length > 0 ? bareLines : [SENTINEL_NONGOAL];
          const ngPrefix = prefixFor(h.span);
          if (ngPrefix !== "") {
            // Line style: replace whole prefixed lines — the line after
            // <non-goals> through the line before </non-goals>.
            const innerStart = next.indexOf("\n", base + ng) + 1;
            const innerEnd = lineStartOf(next, base + ngEnd);
            if (innerStart > 0 && innerStart <= innerEnd) {
              edits.push({
                start: innerStart,
                end: innerEnd,
                text: items.map((i) => `${ngPrefix}  <item>${i}</item>\n`).join(""),
              });
              repairs.push("non-goals-items");
            }
          } else {
            edits.push({
              start: base + ng + "<non-goals>".length,
              end: base + ngEnd,
              text: `\n${items.map((i) => `  <item>${i}</item>`).join("\n")}\n`,
            });
            repairs.push("non-goals-items");
          }
        } else if (itemOpens !== itemCloses) {
          // Same-line `<item>…</non-goals>` closes inline — a line-start
          // insert would emit the close before its own open.
          const itemOpenAbs = base + ng + "<non-goals>".length + inner.lastIndexOf("<item>");
          const itemAbsEnd = base + ngEnd;
          const sameLine =
            prefixFor(h.span) !== "" &&
            lineStartOf(next, itemAbsEnd) === lineStartOf(next, itemOpenAbs);
          const anchor = sameLine ? itemAbsEnd : insertAt(itemAbsEnd, h);
          edits.push({
            start: anchor,
            end: anchor,
            text: sameLine ? `</item> ` : `${lineWrap("</item>", h.span)}\n`,
            order: 10,
          });
          repairs.push("closed-item");
        }
      }
    }
    next = applyEdits(next, edits);
  }

  // Stage 3 — KEY_DECISIONS required by layer/risk but absent.
  {
    const h = reheader();
    if (!h) return stageGuard();
    if (keyDecisionsRequired && !h.text.includes("<KEY_DECISIONS>")) {
      if (riskClass === "high" && aiInvariants.length === 0) {
        return skipped(
          "high-risk file requires an @ai-invariant — header authorship stays agent work",
          source,
        );
      }
      const kd = lineWrap(
        keyDecisionsBlock(aiInvariants.length > 0 ? aiInvariants : [TODO_ITEM]),
        h.span,
      );
      const mc = blockSpan(h.text, "MODULE_CONTRACT");
      if (mc) {
        next = applyEdits(next, [
          { start: h.span.start + mc.end, end: h.span.start + mc.end, text: `\n${kd}` },
        ]);
      } else {
        const at = appendAt(h);
        next = applyEdits(next, [{ start: at, end: at, text: appendText(kd, h.span) }]);
      }
      repairs.push("inserted-key-decisions");
    }
  }

  // Stage 4 — CHANGE_SUMMARY absent entirely (unclosed was repaired in stage 1).
  {
    const h = reheader();
    if (!h) return stageGuard();
    if (!h.text.includes("<CHANGE_SUMMARY>")) {
      const cs = lineWrap("<CHANGE_SUMMARY>\n</CHANGE_SUMMARY>", h.span);
      const anchor =
        blockSpan(h.text, "KEY_DECISIONS")?.end ?? blockSpan(h.text, "MODULE_CONTRACT")?.end;
      if (anchor !== undefined) {
        next = applyEdits(next, [
          { start: h.span.start + anchor, end: h.span.start + anchor, text: `\n${cs}` },
        ]);
      } else {
        const at = appendAt(h);
        next = applyEdits(next, [{ start: at, end: at, text: appendText(cs, h.span) }]);
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

/**
 * Every compass tag present in the header comment closes inside it — inner
 * tags included, so "unchanged" stays aligned with what compass.validate
 * reports (its extractor requires close tags too).
 */
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
  if (!contractText.includes("<purpose>") || !contractText.includes("</purpose>")) return false;
  const ng = blockSpan(contractText, "non-goals");
  if (!ng) return false;
  const ngText = contractText.slice(ng.start, ng.end);
  const itemOpens = (ngText.match(/<item>/g) ?? []).length;
  const itemCloses = (ngText.match(/<\/item>/g) ?? []).length;
  if (itemOpens === 0 || itemOpens !== itemCloses) return false;
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
