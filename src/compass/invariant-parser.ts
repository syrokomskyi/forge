/*
<MODULE_CONTRACT>
<purpose>RFC-1390: pure tagged-`@ai-invariant[INV-<scope>-<NN>]` parser — marker
grammar, comment-region scanning, statement normalization, sha256 identity, and
`checked-by` binding extraction. Shared by the os/compass binding resolver and
cross-package consumers (e.g. werkstatt-site TEST-WEAKEN-10) via
`@warpgogol/forge/compass`.</purpose>
<non-goals>
  <item>Do not resolve bindings against the filesystem — that stays os-side (resolveInvariantBindings).</item>
  <item>Do not import from os/ or @warpgogol/* — src/ is kernel-free and package-autonomous (FORGE-AUTONOMY-01).</item>
  <item>Do not scan `#`/`;`-style comment syntaxes (.gd, .tscn, .tres) — marker extraction covers `//` line comments, slash-star block comments, and HTML comments only; no such files exist in this workspace.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>A marker must open the comment payload — a mid-comment `@ai-invariant` mention is prose, not a declaration.</item>
  <item>The statement runs over contiguous comment lines until code, blank, delimiter, or a fresh marker; `(checked-by: …)` wraps likewise.</item>
  <item>Statement identity is sha256 over whitespace-normalized text — re-indentation and reflow are not weakening; word changes are.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1392: extracted the pure parser from os/compass/handlers/invariant-bindings.ts for cross-package consumption — no behavior change.</item>
  <item>RFC-1392: extend test-weakening gate to generators, invariants, proof specs (RFC-1392)

TEST-WEAKEN-08..11 extend the RFC-1331 analyzer: numRuns budget reduced
or removed, property input domain narrowed (fc.pre / chained .filter /
numeric bound), bound @ai-invariant removed-reworded-unbound via the new
@warpgogol/forge/compass parser export, and *.proof.yaml field weakening
(fail-closed on unreadable or entry-less deletion). Blob collection now
covers implementation files and proof specs. Warn-only until the census
is operator-accepted — TEST_WEAKEN_ENFORCED keeps {01..06}; EC-22 records
advisory rules in the Test-Weakened trailer.</item>
  <item>RFC-1485: sweep compass headers — forge-src + forge root eslint</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";

export type InvariantBindingKind = "test" | "type" | "lint" | "proof";

export const INVARIANT_ID_RE = /^INV-[a-z0-9]+(-[a-z0-9]+)*-\d{2,3}$/;

const MARKER_RE = /^@ai-invariant(?:\[([^\]]*)\])?\s*:\s?(.*)$/;
const CHECKED_BY_RE = /\(\s*checked-by\s*:\s*([^()]*)\)\s*$/i;
export const BINDING_KINDS = new Set<InvariantBindingKind>(["test", "type", "lint", "proof"]);

/**
 * Boilerplate shapes observed in the seeded corpus. Extending the list needs
 * no RFC — it is a tunable constant next to the rule, like the V-40/V-41
 * trigger lists.
 */
export const VACUOUS_INVARIANT_PATTERNS: RegExp[] = [
  /preserve (its|the) core logic/i,
  /this is a high-risk (module|file)/i,
  /minimi[sz]e (external )?side effects/i,
];

const VACUOUS_MIN_WORDS = 6;

export function normalizeInvariantStatement(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

export function invariantStatementSha(statement: string): string {
  return createHash("sha256").update(normalizeInvariantStatement(statement)).digest("hex");
}

export function baselineKey(path: string, statementSha256: string): string {
  return `${path}#${statementSha256}`;
}

/**
 * Comment-region spans of one line. Tracks `/* … *​/` and `<!-- … -->` blocks
 * across lines so markers are only recognised inside comments, and only when
 * the marker opens the comment payload (mid-comment mentions are prose).
 * This is a lexical heuristic, not a tokenizer: an opener immediately
 * preceded by `"`, `'`, `` ` ``, `:`, `/`, or an escape sequence (`\n//`…)
 * is treated as code (string/regex literal, URL scheme, or escaped text)
 * and skipped — a marker inside a *larger* string literal that embeds
 * comment sigils can still false-positive, so keep marker text out of
 * literals (split or escape it, as the test fixtures do).
 */
const OPENER_CODE_PREFIX = new Set(['"', "'", "`", ":", "/"]);

function commentSpans(
  line: string,
  block: "js" | "html" | null,
): { spans: [number, number, boolean][]; block: "js" | "html" | null } {
  const spans: [number, number, boolean][] = [];
  let i = 0;
  while (i < line.length) {
    if (block) {
      const closer = block === "html" ? "-->" : "*/";
      const end = line.indexOf(closer, i);
      if (end === -1) {
        spans.push([i, line.length, true]);
        return { spans, block };
      }
      spans.push([i, end, true]);
      i = end + closer.length;
      block = null;
      continue;
    }
    const candidates: [number, "line" | "js" | "html"][] = [];
    const lineIdx = line.indexOf("//", i);
    if (lineIdx >= 0) candidates.push([lineIdx, "line"]);
    const jsIdx = line.indexOf("/*", i);
    if (jsIdx >= 0) candidates.push([jsIdx, "js"]);
    const htmlIdx = line.indexOf("<!--", i);
    if (htmlIdx >= 0) candidates.push([htmlIdx, "html"]);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a[0] - b[0]);
    const [first, kind] = candidates[0]!;
    // An opener glued to a quote, colon, or slash sits inside a literal or a
    // different opener — resume the scan after it instead of opening a
    // comment. A backslash can never precede a real comment outside a
    // string/template/regex, so a sigil touching an escape (`\n//`, `\//`,
    // `\\/*`, …) is literal text too.
    if (
      (first > 0 && (OPENER_CODE_PREFIX.has(line[first - 1]!) || line[first - 1] === "\\")) ||
      (first > 1 && line[first - 2] === "\\")
    ) {
      i = first + 1;
      continue;
    }
    if (kind === "line") {
      spans.push([first + 2, line.length, false]);
      break;
    }
    block = kind;
    i = first + (kind === "html" ? 4 : 2);
  }
  return { spans, block };
}

/** Comment text of one line: span contents joined, block-continuation `*` stripped. */
function commentTextOf(line: string, block: "js" | "html" | null) {
  const { spans, block: nextBlock } = commentSpans(line, block);
  if (spans.length === 0) return { text: null, block: nextBlock };
  const text = spans
    .map(([s, e, isBlock]) => {
      const seg = line.slice(s, e);
      return isBlock ? seg.replace(/^\s*\*\s?(?!\*)/, "") : seg;
    })
    .join(" ")
    .trim();
  return { text, block: nextBlock };
}

/**
 * Whether a comment line ends a multi-line invariant statement instead of
 * continuing it: annotations (`@param`), markup tags (`<purpose>`), delimiter
 * runs (`// ----`), and fresh invariant markers all start something new.
 */
function isContinuationBoundary(commentText: string): boolean {
  if (commentText.startsWith("@") || commentText.startsWith("<")) return true;
  if (/^[-=_~*#|]{3,}/.test(commentText)) return true;
  return MARKER_RE.test(commentText);
}

export interface RawBinding {
  kind: string;
  target: string;
}

function parseBindingRef(ref: string): RawBinding {
  const idx = ref.indexOf(":");
  if (idx === -1) return { kind: ref.trim(), target: "" };
  return { kind: ref.slice(0, idx).trim(), target: ref.slice(idx + 1).trim() };
}

export interface ParsedInvariant {
  id: string | null;
  malformedId?: string;
  /** A `checked-by` group is present but is not the trailing parenthesised group. */
  malformedCheckedBy?: boolean;
  line: number;
  statement: string;
  rawBindings: RawBinding[];
  vacuous: boolean;
}

/**
 * Extract every `@ai-invariant` from source text — legacy `// @ai-invariant …`
 * (id null) and tagged `// @ai-invariant[INV-x-01] … (checked-by: …)` forms.
 * The marker must open the comment payload — a `@ai-invariant` mention inside
 * a sentence is prose, not a declaration. A statement runs until a code line,
 * a blank comment line, a delimiter-prefixed line, a markup/annotation line,
 * or a fresh marker — contiguous comment lines are the statement (the
 * `(checked-by: …)` tail wraps the same way).
 */
export function extractInvariants(source: string): ParsedInvariant[] {
  const lines = source.split("\n");
  const found: ParsedInvariant[] = [];

  // Comment text per line — markers outside comments never declare invariants.
  const commentTexts: (string | null)[] = [];
  let block: "js" | "html" | null = null;
  for (const line of lines) {
    const { text, block: nextBlock } = commentTextOf(line, block);
    commentTexts.push(text);
    block = nextBlock;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const comment = commentTexts[i];
    if (comment === null) continue;
    const match = MARKER_RE.exec(comment);
    if (!match) continue;

    const bracket = match[1];
    let text = match[2] ?? "";
    const markerLine = i + 1;

    // Join continuation comment lines: the statement runs until a code line,
    // a blank comment line, a delimiter run, a markup/annotation line, or a
    // new invariant marker (the `(checked-by: …)` tail may wrap the same way).
    while (i + 1 < lines.length) {
      const next = commentTexts[i + 1];
      if (next === null || next === "" || isContinuationBoundary(next)) break;
      i += 1;
      text = `${text} ${next}`.trim();
    }

    let bindings: RawBinding[] = [];
    let statement = text;
    const checkedBy = CHECKED_BY_RE.exec(text);
    if (checkedBy) {
      statement = text.slice(0, checkedBy.index).trim();
      bindings = checkedBy[1]!
        .split(",")
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0)
        .map(parseBindingRef);
    }

    const normalized = normalizeInvariantStatement(statement);
    const malformedId =
      bracket !== undefined && !INVARIANT_ID_RE.test(bracket.trim()) ? bracket.trim() : undefined;
    const malformedCheckedBy = !checkedBy && /\(\s*checked-by\s*:/i.test(statement);

    found.push({
      id: malformedId === undefined && bracket !== undefined ? bracket.trim() : null,
      malformedId,
      malformedCheckedBy: malformedCheckedBy || undefined,
      line: markerLine,
      statement: normalized,
      rawBindings: bindings,
      vacuous:
        VACUOUS_INVARIANT_PATTERNS.some((re) => re.test(normalized)) ||
        normalized.split(" ").filter((w) => w.length > 0).length < VACUOUS_MIN_WORDS,
    });
  }

  return found;
}
