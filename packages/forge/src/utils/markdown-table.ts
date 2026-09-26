/*
<MODULE_CONTRACT>
<purpose>
RFC-1154: canonical prettier-normal markdown table emitter. Every forge
emitter routes tables through alignMarkdownTable so generated guides pass
`prettier --check` in consumer projects without forge depending on prettier.
Also provides parseMarkdownTable so existing compact tables can be re-aligned
(idempotency check: parse + re-emit is byte-stable).
</purpose>
<non-goals>
  <item>Do not shell out to prettier — formatting is a pure string transform owned by forge.</item>
  <item>Do not implement alignment colons (left/center/right) — forge emitters never produce them; parse normalizes them away.</item>
  <item>Do not do full grapheme segmentation — cell width uses String.length; generated tables are ASCII-heavy (documented limitation).</item>
</non-goals>
<KEY_DECISIONS>
  <item>Separator = dashes repeated to column width (min 3), matching observed prettier output.</item>
  <item>Escaped pipe inside a cell is a literal, counted as 2 characters of width.</item>
</KEY_DECISIONS>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1154: initial implementation — alignMarkdownTable + parseMarkdownTable.</item>
</CHANGE_SUMMARY>
*/

/** Minimum column width — prettier never emits a separator narrower than `---`. */
const MIN_COLUMN_WIDTH = 3;

export interface ParsedMarkdownTable {
  headers: string[];
  rows: string[][];
}

/**
 * Emit a prettier-normal markdown table: every cell is space-padded so all
 * `|` delimiters align per column, and the separator row is dashes repeated
 * to each column's width. Column width is max(3, widest cell content).
 *
 * Rows may be shorter or longer than headers — missing cells become empty,
 * extra cells extend the column set.
 */
export function alignMarkdownTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0 && rows.length === 0) return "";

  const columnCount = Math.max(headers.length, ...rows.map((r) => r.length));
  const widths: number[] = new Array(columnCount).fill(MIN_COLUMN_WIDTH);
  const track = (cells: string[]) => {
    for (let i = 0; i < columnCount; i++) {
      const cell = cells[i] ?? "";
      if (cell.length > widths[i]) widths[i] = cell.length;
    }
  };
  track(headers);
  for (const row of rows) track(row);

  const renderRow = (cells: string[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < columnCount; i++) {
      parts.push(` ${(cells[i] ?? "").padEnd(widths[i])} `);
    }
    return `|${parts.join("|")}|`;
  };

  const separator = `|${widths.map((w) => ` ${"-".repeat(w)} `).join("|")}|`;

  const lines: string[] = [renderRow(headers), separator];
  for (const row of rows) lines.push(renderRow(row));
  return lines.join("\n");
}

/** Split a markdown table row on unescaped `|` delimiters; `\|` stays literal. */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  // Strip optional outer pipes.
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      current += "\\|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += inner[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

const SEPARATOR_CELL = /^:?-+:?$/;

/**
 * Parse a markdown table into headers + rows. Returns null when the input is
 * not a table (missing separator row). The separator row is detected by
 * cells matching `:?-+:?` and is dropped — alignment colons are normalized
 * away on re-emission (forge emitters never produce them).
 */
export function parseMarkdownTable(text: string): ParsedMarkdownTable | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;

  const separatorIndex = lines.findIndex((line, i) => {
    if (i === 0) return false;
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c));
  });
  if (separatorIndex !== 1) return null;

  return {
    headers: splitRow(lines[0]),
    rows: lines.slice(2).map(splitRow),
  };
}
