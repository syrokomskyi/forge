/*
<MODULE_CONTRACT>
<purpose>Text-splice primitives for a single importer subtree inside
pnpm-lock.yaml (RFC-1544). A mission workpiece registers as the importer key
`missions/<id>/workpiece:` at the fixed two-space indent under `importers:`;
both consumers — flow.integrate's foreign-open-mission restore and
mission.archive's bookkeeping prune — must move exactly that key's block and
nothing else, so a whole-file checkout or a YAML round-trip (which rewrites
unrelated formatting) is never the mechanism.</purpose>
<non-goals>
  <item>No YAML semantics — block boundaries are indent arithmetic on the pnpm-lock layout, not a parse.</item>
  <item>No git/file I/O — pure string transforms; callers own reads and writes.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1544: importer-block extract/insert/remove text splices shared by flow.integrate restore and mission.archive prune</item>
  <item>RFC-1544: attribute mission lockfile churn to owning checkout and auto-resolve foreign importer diffs (RFC-1544)</item>
</CHANGE_SUMMARY>
*/

const IMPORTER_INDENT = 2;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Locate `  <key>:` at the importer indent — exact key, no prefix bleed. */
function importerKeyIndex(lines: string[], key: string): number {
  const wanted = `${" ".repeat(IMPORTER_INDENT)}${key}:`;
  return lines.findIndex((l) => l.trimEnd() === wanted);
}

/**
 * The importer block lines for `key` inside lockfile `text`: the key line
 * plus every deeper-indented member, trailing blanks excluded. Null when the
 * key is absent.
 */
export function extractImporterBlock(text: string, key: string): string[] | null {
  const lines = text.split("\n");
  const start = importerKeyIndex(lines, key);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim().length === 0) {
      end += 1;
      continue;
    }
    if (indentOf(l) <= IMPORTER_INDENT) break;
    end += 1;
  }
  while (end > start + 1 && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

/**
 * `text` without `key`'s importer block — the block plus its separating
 * blank line(s), so removal leaves the surrounding layout intact. Returns
 * the input unchanged when the key is absent.
 */
export function removeImporterBlock(text: string, key: string): string {
  const lines = text.split("\n");
  const start = importerKeyIndex(lines, key);
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim().length === 0) {
      end += 1;
      continue;
    }
    if (indentOf(l) <= IMPORTER_INDENT) break;
    end += 1;
  }
  // Also absorb the blank separator BEFORE the block when one exists —
  // pnpm separates importer stanzas with a single blank line.
  let s = start;
  if (s > 0 && lines[s - 1].trim().length === 0) s -= 1;
  const out = [...lines.slice(0, s), ...lines.slice(end)];
  // Collapse a doubled blank left at the seam when both sides kept one.
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * `text` with `block` inserted under `importers:` at pnpm's alphabetical
 * position — before the first importer key sorting after `key`, else at the
 * end of the importers section. Null when no `importers:` section exists.
 */
export function insertImporterBlock(text: string, key: string, block: string[]): string | null {
  const lines = text.split("\n");
  const importersIdx = lines.findIndex((l) => l.trimEnd() === "importers:");
  if (importersIdx === -1) return null;
  // Section end: first non-blank line with indent < 2 (or EOF).
  let sectionEnd = lines.length;
  for (let i = importersIdx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim().length === 0) continue;
    if (indentOf(l) < IMPORTER_INDENT) {
      sectionEnd = i;
      break;
    }
  }
  // First importer key sorting after ours — mid-section insert.
  for (let i = importersIdx + 1; i < sectionEnd; i += 1) {
    const l = lines[i];
    if (l.trim().length === 0 || indentOf(l) !== IMPORTER_INDENT) continue;
    const other = l.trim().replace(/:$/, "");
    if (other > key) {
      return [...lines.slice(0, i), ...block, "", ...lines.slice(i)].join("\n");
    }
  }
  // End-of-section insert: splice before the trailing blank run when one
  // exists (it already separates the last block from the next section).
  let at = sectionEnd;
  while (at > importersIdx + 1 && lines[at - 1].trim().length === 0) at -= 1;
  const hadTrailingBlanks = at < sectionEnd;
  const payload = ["", ...block, ...(hadTrailingBlanks ? [] : [""])];
  return [...lines.slice(0, at), ...payload, ...lines.slice(at)].join("\n");
}
