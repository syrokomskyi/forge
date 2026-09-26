/*
<MODULE_CONTRACT>
<purpose>RFC-1153: preservation-boundary split/merge for editable generated
files. Pure, no I/O — callers read the existing file and write the merged
result through WorkspaceIO. The `forge:custom` marker line bounds the
generator-owned head; everything below it is carried over verbatim.</purpose>
<non-goals>
  <item>Do not perform file I/O — operates on in-memory content strings only.</item>
  <item>Do not apply to non-editable generated files — GENERATED_MARKER files
  keep the RFC-0081 binary semantics (marker present = overwrite, absent = skip).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1153: initial — splitEditableGenerated + mergeEditableGenerated with
  forge:custom marker boundary and canonical-footer (last non-empty render line) fallback.</item>
</CHANGE_SUMMARY>
*/

import {
  CUSTOM_BOUNDARY_HINTS,
  CUSTOM_BOUNDARY_MARKERS,
  CUSTOM_BOUNDARY_TOKEN,
  commentStyleForPath,
} from "./generated-marker.ts";

export interface EditableRegionSplit {
  /** Content up to and including the boundary line (marker or footer). */
  generatedHead: string;
  /** Content after the boundary line, verbatim. null when empty. */
  customTail: string | null;
  boundary: "marker" | "footer" | "none";
}

/** DNA-58 rule: boundary and footer matching normalize CRLF to LF. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Canonical footer of a render — its last non-empty line. Callers that need
 * the boundary value separately (doctor staleness, preserved-tail detection)
 * derive it from the same render they pass to the merge.
 */
export function canonicalFooterOf(rendered: string): string | null {
  const lines = normalizeNewlines(rendered).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== "") return line;
  }
  return null;
}

/**
 * Split an existing editable generated file at its preservation boundary.
 *
 * Priority:
 * 1. First line containing the `forge:custom` token (comment-style agnostic —
 *    a token in prose is a documented, deliberate-looking boundary hazard).
 *    The marker line and an immediately following canonical hint line belong
 *    to the generated head.
 * 2. `footerLine` (canonical template footer, derived by callers from the
 *    render as its last non-empty line) — first occurrence is the boundary.
 * 3. `"none"` — no resolvable boundary.
 */
export function splitEditableGenerated(
  content: string,
  filePath: string,
  footerLine?: string,
): EditableRegionSplit {
  const text = normalizeNewlines(content);
  const style = commentStyleForPath(filePath);
  const hint = CUSTOM_BOUNDARY_HINTS[style];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.includes(CUSTOM_BOUNDARY_TOKEN)) {
      let headEnd = i + 1;
      if (lines[headEnd] === hint) headEnd += 1;
      const tail = lines.slice(headEnd).join("\n");
      return {
        generatedHead: lines.slice(0, headEnd).join("\n"),
        customTail: tail.trim() === "" ? null : tail,
        boundary: "marker",
      };
    }
  }

  if (footerLine !== undefined) {
    // lastIndexOf: the canonical footer is the template's last line — the
    // trailingmost occurrence is the correct boundary even when an operator
    // copied the line into a mid-file section.
    const idx = lines.lastIndexOf(footerLine);
    if (idx >= 0) {
      const tail = lines.slice(idx + 1).join("\n");
      return {
        generatedHead: lines.slice(0, idx + 1).join("\n"),
        customTail: tail.trim() === "" ? null : tail,
        boundary: "footer",
      };
    }
  }

  return { generatedHead: text, customTail: null, boundary: "none" };
}

/**
 * Merge a fresh render with an existing editable generated file.
 *
 * The canonical footer is derived internally as the last non-empty line of
 * `rendered` — no per-file-kind footer registry exists; when a template tail
 * changes, the boundary follows the new render automatically.
 *
 * Merge contract:
 * - `existing === null` (new file): rendered + boundary marker + hint.
 * - marker boundary: head = fresh render + marker + hint; tail verbatim.
 * - footer boundary (legacy marker-less file): head = fresh render + marker +
 *   hint (marker introduced now); tail = content after the legacy footer line.
 * - none + identical content: clean regeneration, marker + hint appended.
 * - none + divergent content: returns null — caller must skip and warn
 *   (`unmapped-customization`), never overwrite.
 *
 * The result is LF-normalized; callers write through `writeFileIfChanged`.
 */
export function mergeEditableGenerated(
  rendered: string,
  existing: string | null,
  filePath: string,
): string | null {
  const render = normalizeNewlines(rendered);
  const style = commentStyleForPath(filePath);
  const marker = CUSTOM_BOUNDARY_MARKERS[style];
  const hint = CUSTOM_BOUNDARY_HINTS[style];
  const boundaryBlock = `${marker}\n${hint}\n`;

  if (existing === null) {
    return `${render}${boundaryBlock}`;
  }

  const text = normalizeNewlines(existing);
  const footer = canonicalFooterOf(render);
  const split = splitEditableGenerated(text, filePath, footer ?? undefined);

  if (split.boundary === "marker" || split.boundary === "footer") {
    return `${render}${boundaryBlock}${split.customTail ?? ""}`;
  }

  if (text === render || text === `${render}${boundaryBlock}`) {
    return `${render}${boundaryBlock}`;
  }

  return null;
}
