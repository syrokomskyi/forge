/*
<MODULE_CONTRACT>
<purpose>
RFC-1455: parse and evaluate the `## Fixed inputs` section of an RFC.
Every value an RFC fixes for the shipped result (verbatim copy, labels,
names, decided option values) is declared as a row bound to one AC-N —
and rfc.validate rejects a row whose criterion is missing or whose bound
probes cannot observe the value (V-50 error). Design/Rollout prose that
claims a verbatim value without declaring the section earns a V-51
warning nudge. All functions are pure — no I/O.
</purpose>
<non-goals>
  <item>Does not check whether the probe would actually pass — containment is a static contract check only; execution is RFC-1453.</item>
  <item>Does not parse fenced example tables — the caller passes a fence-stripped body.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1455: fixed-inputs section parser + V-50/V-51 evaluator for rfc.validate.</item>
  <item>RFC-1455: fixed inputs bound to outcome probes — V-50/V-51 + skills</item>
  <item>RFC-1569: lint rfc evidence annotations and transient probe targets</item>
</CHANGE_SUMMARY>
*/

import type { AcceptanceProbe } from "../types.ts";

export interface FixedInputRow {
  id: string;
  value: string;
  source: string;
  checkedBy: string;
  line: number;
}

export interface FixedInputsSection {
  found: boolean;
  rows: FixedInputRow[];
}

export interface FixedInputDiagnostic {
  ruleId: "V-50" | "V-51";
  severity: "error" | "warning";
  message: string;
}

const FIXED_INPUTS_HEADING = /^## Fixed inputs\s*$/m;
const HEADER_CELL_NAMES = ["id", "value", "source", "checked by"] as const;
const FI_ID_PATTERN = /^FI-\d+$/;
const AC_ID_PATTERN = /^AC-\d+$/;

/** Verbatim prose markers — a nudge list, not a parser (RFC-1455 V-51). */
const VERBATIM_MARKERS = ["verbatim", "дословно", "wörtlich", "exact text"] as const;

function sectionText(strippedBody: string, heading: RegExp): string | undefined {
  const match = strippedBody.match(heading);
  if (!match || match.index === undefined) return undefined;
  const start = match.index + match[0].length;
  const rest = strippedBody.slice(start);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Split a markdown table line into cells, honoring `\|` escapes. */
function splitTableRow(line: string): string[] | null {
  let trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      current += ch === "|" ? "|" : `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  cells.push(current);
  return cells.map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s:|-]+\|?\s*$/.test(line.trim()) && line.includes("-");
}

/** Locate the `## Fixed inputs` table by its exact header row. */
export function parseFixedInputs(strippedBody: string): FixedInputsSection {
  const section = sectionText(strippedBody, FIXED_INPUTS_HEADING);
  if (section === undefined) return { found: false, rows: [] };

  const lines = section.split("\n");
  const rows: FixedInputRow[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cells = splitTableRow(line);
    if (!inTable) {
      if (!cells) continue;
      const normalized = cells.map((c) => c.toLowerCase());
      const isHeader =
        normalized.length === HEADER_CELL_NAMES.length &&
        HEADER_CELL_NAMES.every((name, idx) => normalized[idx] === name);
      if (!isHeader) continue;
      const sep = lines[i + 1];
      if (sep === undefined || !isSeparatorRow(sep)) continue;
      inTable = true;
      i += 1; // skip separator
      continue;
    }
    if (!cells) break; // first non-table line ends the table
    const [id, value, source, checkedBy] = cells;
    rows.push({
      id: (id ?? "").trim(),
      value: (value ?? "").trim(),
      source: (source ?? "").trim(),
      checkedBy: (checkedBy ?? "").trim(),
      line: i + 1,
    });
  }
  return { found: true, rows };
}

/** Extract the literal segments (`…` or «…») the row pins. */
export function fixedInputLiterals(rawValue: string): string[] {
  const literals: string[] = [];
  for (const match of rawValue.matchAll(/`([^`]+)`|«([^»]+)»/g)) {
    const text = (match[1] ?? match[2] ?? "").trim();
    if (text) literals.push(normalizeLiteral(text));
  }
  if (literals.length === 0) {
    const fallback = normalizeLiteral(rawValue.replace(/^[«`"']+|[»`"']+$/g, ""));
    if (fallback) literals.push(fallback);
  }
  return literals;
}

function normalizeLiteral(text: string): string {
  return text.replace(/\\\|/g, "|").replace(/\s+/g, " ").trim();
}

function outcomeProbeFields(probe: AcceptanceProbe): string[] {
  if (probe.probe === "file-contains") return [probe.pattern];
  if (probe.probe === "page") {
    return [probe.textPattern, probe.selector].filter(
      (f): f is string => typeof f === "string" && f.length > 0,
    );
  }
  return [];
}

/**
 * V-50/V-51 evaluation. `strippedBody` must already be fence-stripped
 * (shared with the acceptance-criteria scan so fenced examples never
 * register as rows). `criterionIds` is the AC-N set from
 * evaluateAcceptanceCriteria; `probes` is the frontmatter acceptance list.
 */
export function evaluateFixedInputs(
  strippedBody: string,
  criterionIds: string[],
  probes: AcceptanceProbe[],
): FixedInputDiagnostic[] {
  const diagnostics: FixedInputDiagnostic[] = [];
  const section = parseFixedInputs(strippedBody);

  if (!section.found) {
    const design = sectionText(strippedBody, /^## Design\s*$/m) ?? "";
    const rollout = sectionText(strippedBody, /^## Rollout\s*$/m) ?? "";
    const lines = `${design}\n${rollout}`.split("\n");
    const hits = lines.filter((line) =>
      VERBATIM_MARKERS.some((m) => line.toLowerCase().includes(m.toLowerCase())),
    );
    if (hits.length > 0) {
      diagnostics.push({
        ruleId: "V-51",
        severity: "warning",
        message:
          `${hits.length} Design/Rollout line(s) mark a value as verbatim (${VERBATIM_MARKERS.join(", ")}) ` +
          `but the RFC declares no "## Fixed inputs" section — record decided values as probe-bound rows (RFC-1455).`,
      });
    }
    return diagnostics;
  }

  const seenIds = new Set<string>();
  for (const row of section.rows) {
    const label = `fixed input ${row.id || "(no id)"}`;

    if (row.id && !FI_ID_PATTERN.test(row.id)) {
      diagnostics.push({
        ruleId: "V-50",
        severity: "error",
        message: `${label} has malformed id — expected FI-N.`,
      });
    } else if (row.id && seenIds.has(row.id)) {
      diagnostics.push({
        ruleId: "V-50",
        severity: "error",
        message: `${label} duplicates an earlier row id.`,
      });
    }
    seenIds.add(row.id);

    if (!AC_ID_PATTERN.test(row.checkedBy) || !criterionIds.includes(row.checkedBy)) {
      diagnostics.push({
        ruleId: "V-50",
        severity: "error",
        message: AC_ID_PATTERN.test(row.checkedBy)
          ? `${label} names criterion "${row.checkedBy}" which does not exist in acceptance criteria.`
          : `${label} must name exactly one AC-N criterion in "Checked by" (got "${row.checkedBy || "empty"}").`,
      });
      continue;
    }

    const bound = probes.filter((p) => p.criterion === row.checkedBy);
    const outcomeFields = bound.flatMap(outcomeProbeFields);
    if (outcomeFields.length === 0) {
      diagnostics.push({
        ruleId: "V-50",
        severity: "error",
        message:
          `${label} binds ${row.checkedBy}, which has no outcome probe — ` +
          `bind a "page" (textPattern/selector) or "file-contains" probe (RFC-1455).`,
      });
      continue;
    }

    const literals = fixedInputLiterals(row.value);
    // RFC-1569: compare against the regex-UNESCAPED pattern too — a literal
    // carrying metacharacters (${WORKSPACE_ROOT}) cannot be both escaped in
    // the pattern and contained verbatim; `\d`/`\w` shorthand keeps its
    // backslash (unescaping it would fake coverage for single-char literals).
    const unescapePattern = (field: string): string =>
      field.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
    const uncovered = literals.filter(
      (literal) =>
        !outcomeFields.some(
          (field) => field.includes(literal) || unescapePattern(field).includes(literal),
        ),
    );
    if (uncovered.length > 0) {
      diagnostics.push({
        ruleId: "V-50",
        severity: "error",
        message:
          `${label} value ${uncovered.map((v) => `"${v}"`).join(", ")} is not contained in ` +
          `${row.checkedBy}'s bound probe pattern — the probe must check this value (RFC-1455).`,
      });
    }
  }
  return diagnostics;
}
