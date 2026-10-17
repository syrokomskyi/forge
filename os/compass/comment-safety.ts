/*
<MODULE_CONTRACT>
<purpose>
comment-safety — the shared comment-terminator contract for Compass text
writers (RFC-1323). Owns CommentStyle detection plus the
findCompassTerminator/assertCompassCommentSafe/neutralizeCompassText triple:
authored text rejects with COMPASS-CS-08, injected free text neutralizes the
terminator pair into a non-terminating glyph, and the header-region scan
detects latent corruption in existing files.
</purpose>
<non-goals>
  <item>Do not strip Compass tags from text — sanitizeItemText in summary-record.ts keeps that duty and delegates the terminator rewrite here.</item>
  <item>Do not parse whole files — detection works on raw header-region text; parseCompassBlocks never sees the terminator that truncated its input.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Two policies: authored text throws COMPASS-CS-08 (author rewords); injected text neutralizes (operators cannot reword commit messages).</item>
  <item>Neutralization swaps one ASCII glyph for its non-ASCII look-alike — byte-light, idempotent, can never re-form a terminator.</item>
  <item>Scanning tracks tag state only inside comment spans; a terminator fires while a structural block tag stays unclosed.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1323: created — CommentStyle/commentStyleFor/getLineCommentPrefix/HEADER_SCAN_LINES consolidated here; terminator triple + CompassCommentSafetyError + header-region CS-08 scan.</item>
  <item>RFC-1323: write-time comment-terminator safety — shared comment-safety seam, authored CS-08 reject, injected neutralization, header-region scan</item>
</CHANGE_SUMMARY>
*/

/** The comment grammar a file's Compass header lives in. */
export type CommentStyle = "block" | "html" | "line";

/** Line-comment prefixes for prefix-run styles (.gd `#`, .tscn/.tres `;`). */
export function getLineCommentPrefix(filePath: string): string | null {
  if (filePath.endsWith(".gd")) return "# ";
  if (filePath.endsWith(".tscn") || filePath.endsWith(".tres")) return "; ";
  return null;
}

/**
 * A CHANGE_SUMMARY/Compass block counts as a header only within this many
 * lines from the file top — deeper matches are doc examples or template
 * strings, not headers. Shared by the writer guards and the CS-08 scan.
 */
export const HEADER_SCAN_LINES = 120;

/**
 * Comment styles a file type may carry, most likely first. .astro headers
 * exist in both forms — block comments inside the `---` frontmatter and html
 * comments in the markup below — so both are candidates at detection time.
 */
export function commentStyleCandidates(path: string): CommentStyle[] {
  if (path.endsWith(".astro")) return ["block", "html"];
  if (path.endsWith(".md")) return ["html"];
  if (getLineCommentPrefix(path) !== null) return ["line"];
  return ["block"];
}

export function commentStyleFor(path: string): CommentStyle {
  return commentStyleCandidates(path)[0]!;
}

/**
 * The style of the comment that encloses `index` in `source` — the ground
 * truth for edits inside an EXISTING header (record/trim/migrate), where
 * commentStyleFor is only an extension guess. .astro is the case that
 * matters: its header may sit in a `<!-- -->` markup comment while the
 * extension table says "block". Whichever comment opener directly precedes
 * the index wins; line-prefix files keep their own style; no opener found
 * falls back to the extension table.
 */
export function enclosingCommentStyle(source: string, index: number, path: string): CommentStyle {
  if (getLineCommentPrefix(path) !== null) return "line";
  const blockOpen = source.lastIndexOf("/*", index);
  const htmlOpen = source.lastIndexOf("<!--", index);
  if (blockOpen === -1 && htmlOpen === -1) return commentStyleFor(path);
  return htmlOpen > blockOpen ? "html" : "block";
}

/**
 * Sequences that terminate or corrupt a comment of the given style when they
 * appear inside its text. Line comments have no embedded terminator — a
 * newline is structural and already handled by line-item formatting.
 */
const COMPASS_TERMINATORS: Record<CommentStyle, readonly string[]> = {
  block: ["*/"],
  html: ["-->", "<!--"],
  line: [],
};

/**
 * The neutralization table (decided at session-20261017-1943, Q-5): each
 * terminator loses one ASCII glyph to its non-ASCII look-alike. The result is
 * byte-preserving except the glyph and idempotent — the substitutes can never
 * re-form a terminator on a second pass.
 */
const NEUTRALIZATION: Record<CommentStyle, ReadonlyArray<readonly [string, string]>> = {
  block: [["*/", "*∕"]], // solidus / → ∕ U+2215
  html: [
    ["-->", "--›"], // > → › U+203A
    ["<!--", "‹!--"], // < → ‹ U+2039
  ],
  line: [],
};

/**
 * First terminator present in `text` for the style, or null. Scans raw text —
 * a terminator inside a quoted example still counts (conservative; authors
 * reword).
 */
export function findCompassTerminator(text: string, style: CommentStyle): string | null {
  for (const terminator of COMPASS_TERMINATORS[style]) {
    if (text.includes(terminator)) return terminator;
  }
  return null;
}

/** COMPASS-CS-08 payload carried by authored-surface rejections. */
export class CompassCommentSafetyError extends Error {
  readonly ruleId = "COMPASS-CS-08" as const;
  readonly substring: string;
  readonly file?: string;
  readonly block?: string;
  readonly fixHint: string;

  constructor(substring: string, context?: { file?: string; block?: string }) {
    const where = [context?.file, context?.block].filter(Boolean).join(" / ");
    super(
      `COMPASS-CS-08: comment-close sequence "${substring}" in Compass block text${where ? ` (${where})` : ""}`,
    );
    this.name = "CompassCommentSafetyError";
    this.substring = substring;
    this.file = context?.file;
    this.block = context?.block;
    this.fixHint =
      "Reword so the terminator pair never appears: space the glyphs apart, describe the path without the glob (e.g. packages/<pkg>/AGENTS.md), or XML-escape the characters. Injected text (commit messages) is neutralized automatically instead of rejected.";
  }
}

/**
 * Fail-closed guard for authored Compass block text — throws
 * CompassCommentSafetyError (COMPASS-CS-08) when `text` carries the style's
 * terminator. Call at emission time, before the text lands in a comment.
 */
export function assertCompassCommentSafe(
  text: string,
  style: CommentStyle,
  context?: { file?: string; block?: string },
): void {
  const substring = findCompassTerminator(text, style);
  if (substring !== null) {
    throw new CompassCommentSafetyError(substring, context);
  }
}

/**
 * Style-aware terminator neutralization for injected free text — rewrites
 * each terminator pair into its visually-identical non-terminating form and
 * reports whether the text changed. Second pass is a no-op.
 */
export function neutralizeCompassText(
  text: string,
  style: CommentStyle,
): { text: string; neutralized: boolean } {
  let out = text;
  for (const [from, to] of NEUTRALIZATION[style]) {
    out = out.replaceAll(from, to);
  }
  return { text: out, neutralized: out !== text };
}

/**
 * Compass tags whose open state decides whether a close marker is a legal
 * comment end or corruption — the outer block tags plus the nested tags that
 * can still be open when the truncation lands.
 */
const COMPASS_INNER_TAGS = [
  "MODULE_CONTRACT",
  "KEY_DECISIONS",
  "CHANGE_SUMMARY",
  "purpose",
  "non-goals",
  "item",
  "history",
] as const;

/** Top-level Compass block tags — a truncation only counts while one is open. */
const COMPASS_STRUCTURAL_TAGS = ["MODULE_CONTRACT", "KEY_DECISIONS", "CHANGE_SUMMARY"] as const;

const CS08_TOKEN_RE = new RegExp(
  `<(?:${COMPASS_INNER_TAGS.join("|")})>|</(?:${COMPASS_INNER_TAGS.join("|")})>|\\*\\/|\\/\\*|-->|<!--`,
  "g",
);

export interface CompassTerminatorHit {
  substring: string;
  /** Byte offset of the terminator inside the scanned region. */
  offset: number;
  /** 1-based line number. */
  line: number;
}

/**
 * COMPASS-CS-08 scan over the raw header region: the style's close marker
 * appearing while a Compass inner tag is still unclosed means the comment was
 * truncated mid-block — the corrupted tail is invisible to parseCompassBlocks,
 * so detection must run on raw text.
 *
 * Tag state is tracked only INSIDE comment spans: once the header comment
 * closes, tag-shaped literals in code strings and regexes are inert noise.
 * `/*` opens a block region for block-capable files, `<!--` for html-capable
 * ones; the style's close marker exits the region — firing instead when tags
 * are still open. The close landing with every tag closed is the comment's
 * legitimate own close and never fires.
 *
 * For .astro both candidate comment styles are recognized — either header
 * form can be corrupted. Line-style files carry no embedded terminator and
 * are never flagged.
 */
export function findCompassTerminatorInHeader(
  source: string,
  path: string,
): CompassTerminatorHit | null {
  const region = source.split("\n").slice(0, HEADER_SCAN_LINES).join("\n");
  const styles = commentStyleCandidates(path);
  const canBlock = styles.includes("block");
  const canHtml = styles.includes("html");
  if (!canBlock && !canHtml) return null;

  let inComment: "block" | "html" | null = null;
  const open = new Set<string>();
  for (const m of region.matchAll(CS08_TOKEN_RE)) {
    const token = m[0];
    if (inComment === null) {
      if (token === "/*" && canBlock) inComment = "block";
      else if (token === "<!--" && canHtml) inComment = "html";
      continue;
    }
    const terms = COMPASS_TERMINATORS[inComment];
    if (terms.includes(token)) {
      // A terminator while a STRUCTURAL Compass block tag remains open —
      // mid-block truncation. A bare <item>/<purpose> in a doc comment is not
      // a Compass block (inner tags only nest inside a structural parent), so
      // those alone never fire.
      if (COMPASS_STRUCTURAL_TAGS.some((tag) => open.has(tag))) {
        const offset = m.index!;
        return {
          substring: token,
          offset,
          line: region.slice(0, offset).split("\n").length,
        };
      }
      // Legal own-close exits the region (open must not leak into the next
      // comment's state); a nested html opener inside a clean html comment
      // is stray but cannot have truncated Compass tags.
      if (token === "*/" || token === "-->") {
        inComment = null;
        open.clear();
      }
      continue;
    }
    // Inner-tag open/close — only Compass names are tracked; angle tokens of
    // other shapes (an html opener scanned inside a block comment, generic
    // markup) keep out of the set.
    const name = token.replace(/^<\/?/, "").replace(/>$/, "");
    if (!(COMPASS_INNER_TAGS as readonly string[]).includes(name)) continue;
    if (token.startsWith("</")) open.delete(name);
    else open.add(name);
  }
  return null;
}
