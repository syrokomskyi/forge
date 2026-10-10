/*
<MODULE_CONTRACT>
<purpose>Canonical "Semantic layer — read first" AGENTS.md block for the Compass docs corpus: one renderer shared by the generated root, nested workspace guides, and the marker-guarded injection path for hand-written AGENTS.md files. Keeps the read-first contract identical on every surface it lands on.</purpose>
<non-goals>
  <item>Do not read forge.yaml, resolve bindings, or touch the filesystem — pure string functions only; callers resolve paths.compassDocs and perform I/O.</item>
  <item>Do not merge or preserve authored content — injection only refreshes the marker-guarded region; everything outside the markers stays verbatim.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Markers are the contract — a region pasted into a hand-written file stays refreshable through the same injection path.</item>
  <item>forge:semantic-layer sentinel opts hand-written files in; the marked region refreshes in place thereafter.</item>
  <item>Regions beat stray sentinels — the block appears at most once per file.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>created — shared read-first block renderer, marker-guarded injection for hand-written AGENTS.md, and ensureSemanticLayerBlock for renders that bypass the fallback template (consumer field report follow-up to RFC-1253).</item>
</CHANGE_SUMMARY>
*/

/** Opt-in sentinel for hand-written AGENTS.md files — expands into a full marked region. */
export const SEMANTIC_LAYER_OPT_IN = "<!-- forge:semantic-layer -->";
/** Region markers emitted around the generated block and matched by injection. */
export const SEMANTIC_LAYER_BEGIN = "<!-- forge:begin semantic-layer -->";
export const SEMANTIC_LAYER_END = "<!-- forge:end semantic-layer -->";

/**
 * The canonical read-first block, marker-wrapped. `compassDocs` is the bound
 * `paths.compassDocs` list — callers filter non-string entries before calling.
 */
export function semanticLayerLines(compassDocs: readonly string[]): string[] {
  const lines = [
    SEMANTIC_LAYER_BEGIN,
    "",
    "## Semantic layer — read first",
    "",
    "This repository carries a machine-readable Compass corpus — the semantic layer that answers “what reads X, what breaks if I change Y” without a full repository re-scan. For repository-wide, cross-workspace, architectural, shared-package, or high-risk tasks, read these documents before planning or editing code:",
    "",
  ];
  for (const doc of compassDocs) lines.push(`- \`${doc}\``);
  lines.push(
    "",
    "Treat these XML documents as the primary semantic layer for AI work and keep them synchronized with code, architecture, and verification changes.",
    "",
    SEMANTIC_LAYER_END,
  );
  return lines;
}

export interface SemanticLayerInjection {
  content: string;
  changed: boolean;
  /** How the block landed: existing region refreshed, opt-in expanded, or no anchor found. */
  region: "refreshed" | "expanded" | "none";
}

/**
 * Guarantee the block is present in generated render output — a safety net for
 * content paths that bypass {@link semanticLayerLines} (e.g. a profile-authored
 * nested template selected over the fallback render). Content already carrying
 * the region is returned as-is; otherwise the block is inserted before
 * `footerLine` (the canonical merge boundary stays the last substantive line)
 * or appended when no footer is found.
 */
export function ensureSemanticLayerBlock(
  content: string,
  block: string,
  footerLine?: string,
): string {
  if (!block || content.includes(SEMANTIC_LAYER_BEGIN)) return content;
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blockLines = block.split("\n");
  const footerIdx = footerLine
    ? lines.findIndex((line) => line.trim() === footerLine)
    : -1;
  if (footerIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return [...lines, "", ...blockLines, ""].join("\n");
  }
  const lead = footerIdx > 0 && lines[footerIdx - 1]!.trim() !== "" ? [""] : [];
  lines.splice(footerIdx, 0, ...lead, ...blockLines, "");
  return lines.join("\n");
}

/**
 * Inject or refresh the marker-guarded semantic-layer region in file content.
 * `block` is the marker-wrapped render ({@link semanticLayerLines} joined).
 *
 * - Every complete `forge:begin semantic-layer` … `forge:end semantic-layer`
 *   region is replaced with the current block (content refresh is free).
 * - When no region exists, the first bare `forge:semantic-layer` sentinel line
 *   expands into a full region.
 * - Files carrying neither anchor return unchanged — injection is opt-in only.
 *
 * Matching normalizes CRLF to LF (the DNA-58 convention shared with
 * editable-region.ts); marker lines match on trimmed equality.
 */
export function injectSemanticLayerBlock(content: string, block: string): SemanticLayerInjection {
  const text = content.replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  // Pass 1: refresh complete begin..end regions.
  const out: string[] = [];
  let changed = false;
  let refreshed = false;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() === SEMANTIC_LAYER_BEGIN) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() !== SEMANTIC_LAYER_END) j++;
      if (j < lines.length) {
        if (lines.slice(i, j + 1).join("\n") !== block) changed = true;
        out.push(block);
        refreshed = true;
        i = j + 1;
        continue;
      }
      // Unbalanced begin (no matching end) — fall through, leave the line alone.
    }
    out.push(lines[i]!);
    i++;
  }
  if (refreshed) {
    return { content: out.join("\n"), changed, region: "refreshed" };
  }

  // Pass 2: no region — expand the first bare opt-in sentinel.
  const idx = out.findIndex((line) => line.trim() === SEMANTIC_LAYER_OPT_IN);
  if (idx === -1) {
    return { content: text, changed: false, region: "none" };
  }
  out[idx] = block;
  return { content: out.join("\n"), changed: true, region: "expanded" };
}
