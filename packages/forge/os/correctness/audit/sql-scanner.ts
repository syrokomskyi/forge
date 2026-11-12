/*
<MODULE_CONTRACT>
<purpose>RFC-1579: built-in literal scanner — collects string and template
literals from TypeScript source (comments skipped, `${…}` nesting tracked),
classifies SQL statements by an uppercase leading keyword followed by SQL
structure, and extracts the tables a statement reads and writes. Also the
JSONC stripper used for wrangler.json/jsonc.</purpose>
<non-goals>
  <item>No TypeScript compiler at runtime — `typescript` is only a dev dependency of forge.</item>
  <item>No SQL parser — table extraction is lexical; unpreparable statements are unverifiable, never blocking.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Uppercase keywords only: "Update your profile" and "Select a target" never match.</item>
  <item>Interpolated templates keep their table extraction (with `${…}` replaced by `?`) but are never prepared.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial scanner, classifier, table extraction, JSONC stripper.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

export interface StringLiteral {
  text: string;
  line: number;
  /** True for a template literal with at least one `${…}` substitution. */
  interpolated: boolean;
}

/** Collect string and template literals, skipping comments and regex-free code. */
export function scanLiterals(source: string): StringLiteral[] {
  const out: StringLiteral[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  const advance = (ch: string) => {
    if (ch === "\n") line += 1;
  };
  const readTemplate = (startLine: number): void => {
    // i points just past the opening backtick (or past the `}` closing a substitution).
    let text = "";
    let interpolated = false;
    while (i < n) {
      const ch = source[i]!;
      if (ch === "\\") {
        text += source.slice(i, i + 2);
        advance(source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === "`") {
        i += 1;
        out.push({ text, line: startLine, interpolated });
        return;
      }
      if (ch === "$" && source[i + 1] === "{") {
        interpolated = true;
        text += "?";
        i += 2;
        // Skip the substitution expression, honouring nested braces and strings.
        let depth = 1;
        while (i < n && depth > 0) {
          const c = source[i]!;
          if (c === "{") depth += 1;
          else if (c === "}") depth -= 1;
          else if (c === '"' || c === "'") {
            const q = c;
            i += 1;
            while (i < n && source[i] !== q && source[i] !== "\n") {
              if (source[i] === "\\") i += 1;
              i += 1;
            }
          } else if (c === "`") {
            i += 1;
            readTemplate(line);
            continue;
          }
          advance(c);
          i += 1;
        }
        continue;
      }
      text += ch;
      advance(ch);
      i += 1;
    }
  };

  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        advance(source[i]!);
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      const q = ch;
      i += 1;
      let text = "";
      while (i < n && source[i] !== q && source[i] !== "\n") {
        if (source[i] === "\\") {
          text += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        text += source[i];
        i += 1;
      }
      i += 1;
      out.push({ text, line: startLine, interpolated: false });
      continue;
    }
    if (ch === "`") {
      i += 1;
      readTemplate(line);
      continue;
    }
    advance(ch);
    i += 1;
  }
  return out;
}

export type StatementKind = "select" | "insert" | "update" | "delete" | "with" | "replace";

const STATEMENT_SHAPES: [StatementKind, RegExp][] = [
  ["select", /^SELECT\b[\s\S]*\bFROM\b/],
  ["insert", /^INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\b/],
  ["update", /^UPDATE\b[\s\S]*\bSET\b/],
  ["delete", /^DELETE\s+FROM\b/],
  ["with", /^WITH\b[\s\S]*\bAS\s*\(/],
  ["replace", /^REPLACE\s+INTO\b/],
];

export interface SqlStatement {
  file: string;
  line: number;
  sql: string;
  kind: StatementKind;
  interpolated: boolean;
}

/** Classify one literal; null when it is not an SQL statement. */
export function classifyStatement(text: string): StatementKind | null {
  const trimmed = text.trim();
  for (const [kind, re] of STATEMENT_SHAPES) if (re.test(trimmed)) return kind;
  return null;
}

/** Every SQL statement literal of one source file. */
export function scanStatements(file: string, source: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  for (const lit of scanLiterals(source)) {
    const kind = classifyStatement(lit.text);
    if (kind)
      out.push({
        file,
        line: lit.line,
        sql: lit.text.trim(),
        kind,
        interpolated: lit.interpolated,
      });
  }
  return out;
}

const IDENT = `["\`\\[]?([A-Za-z_][A-Za-z0-9_]*)["\`\\]]?`;
const WRITE_RES = [
  new RegExp(`\\bINSERT\\s+(?:OR\\s+[A-Za-z]+\\s+)?INTO\\s+${IDENT}`, "gi"),
  new RegExp(`\\bREPLACE\\s+INTO\\s+${IDENT}`, "gi"),
  new RegExp(`\\bUPDATE\\s+(?:OR\\s+[A-Za-z]+\\s+)?${IDENT}\\s+SET\\b`, "gi"),
  new RegExp(`\\bDELETE\\s+FROM\\s+${IDENT}`, "gi"),
];
const READ_RE = new RegExp(`\\b(FROM|JOIN)\\s+${IDENT}`, "gi");

/** Tables a statement (or migration script) reads and writes, lower-cased. */
export function tableAccess(sql: string): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const deleteTargets = new Set<number>();
  for (const re of WRITE_RES) {
    for (const m of sql.matchAll(re)) {
      writes.add(m[1]!.toLowerCase());
      if (/^DELETE/i.test(m[0])) deleteTargets.add(m.index! + m[0].toUpperCase().indexOf("FROM"));
    }
  }
  for (const m of sql.matchAll(READ_RE)) {
    if (deleteTargets.has(m.index!)) continue;
    reads.add(m[2]!.toLowerCase());
  }
  return { reads, writes };
}

/** Strip `//` and `/* *\/` comments and trailing commas from JSONC (strings respected). */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
