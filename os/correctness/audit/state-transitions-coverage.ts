/*
<MODULE_CONTRACT>
<purpose>RFC-1579 CORR-AUDIT-03 `state.transitions.coverage` — every target
state of an explicitly declared machine needs a writer. A machine is declared
by a comment marker directly above its transition table:
`// @state-machine[<name>] (writers: <fn>[, <fn>]) [(column: <sql column>)]`.
Tables are an array of `{ from: "…", to: "…" }` object literals or a
`Record<State, State[]>` object literal. A target `S` is covered when a
non-test file calls a declared writer with `S` as a string-literal argument,
iterates a literal tuple containing `S` into that call, or carries a static
SQL UPDATE/INSERT literal setting the declared column to `'S'`.</purpose>
<non-goals>
  <item>No inference from string-literal unions — only declared machines are audited.</item>
  <item>No runtime proof — the dynamic half is an L2 manifest oracle (RFC-1578).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial auditor and marker grammar.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import { isTestFile, type TreeSnapshot } from "./snapshot.ts";
import { scanStatements } from "./sql-scanner.ts";
import type { AuditorOutput, RawFinding } from "./types.ts";

const MARKER_RE =
  /\/\/\s*@state-machine\[([A-Za-z0-9_-]+)\]\s*\(\s*writers\s*:\s*([^)]*)\)\s*(?:\(\s*column\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\))?/;

export interface StateMachine {
  name: string;
  file: string;
  line: number;
  writers: string[];
  column: string | null;
  edges: { from: string; to: string }[];
}

/** Index of the bracket that closes the one at `open` (strings respected), or -1. */
function matchBracket(text: string, open: number): number {
  const opener = text[open]!;
  const closer = opener === "[" ? "]" : opener === "{" ? "}" : ")";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i += 1;
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const STR = `["'\`]([^"'\`]+)["'\`]`;

function parseTable(literal: string): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = [];
  if (literal.startsWith("[")) {
    for (const obj of literal.matchAll(/\{[^{}]*\}/g)) {
      const from = new RegExp(`\\bfrom\\s*:\\s*${STR}`).exec(obj[0])?.[1];
      const to = new RegExp(`\\bto\\s*:\\s*${STR}`).exec(obj[0])?.[1];
      if (from && to) edges.push({ from, to });
    }
  } else {
    const body = literal.slice(1, -1);
    for (const m of body.matchAll(
      new RegExp(`(?:${STR}|([A-Za-z_][A-Za-z0-9_]*))\\s*:\\s*\\[([^\\]]*)\\]`, "g"),
    )) {
      const from = m[1] ?? m[2]!;
      for (const t of m[3]!.matchAll(new RegExp(STR, "g"))) edges.push({ from, to: t[1]! });
    }
  }
  return edges;
}

/** Find every declared machine in the snapshot's non-test files. */
export function findStateMachines(snapshot: TreeSnapshot): StateMachine[] {
  const machines: StateMachine[] = [];
  for (const [file, text] of snapshot.files) {
    if (isTestFile(file) || !text.includes("@state-machine[")) continue;
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const lineText = lines[i]!;
      const m = MARKER_RE.exec(lineText);
      if (m) {
        const afterMarker = offset + lineText.length + 1;
        const eq = text.indexOf("=", afterMarker);
        let open = eq === -1 ? -1 : eq + 1;
        while (open !== -1 && open < text.length && /\s/.test(text[open]!)) open += 1;
        const edges: { from: string; to: string }[] = [];
        if (open !== -1 && (text[open] === "[" || text[open] === "{")) {
          const close = matchBracket(text, open);
          if (close !== -1) edges.push(...parseTable(text.slice(open, close + 1)));
        }
        machines.push({
          name: m[1]!,
          file,
          line: i + 1,
          writers: m[2]!
            .split(",")
            .map((w) => w.trim())
            .filter((w) => /^[A-Za-z_$][\w$]*$/.test(w)),
          column: m[3] ?? null,
          edges,
        });
      }
      offset += lineText.length + 1;
    }
  }
  return machines;
}

/** Writer names of every declared machine (feeds the two-pass snapshot loader). */
export function declaredWriters(files: Map<string, string>): string[] {
  return [...new Set(findStateMachines({ label: "", files }).flatMap((m) => m.writers))];
}

function stringLiterals(text: string): string[] {
  return [...text.matchAll(new RegExp(STR, "g"))].map((m) => m[1]!);
}

/** States a writer call or literal-tuple loop feeding it covers in one file. */
function coveredByCalls(text: string, writer: string): Set<string> {
  const covered = new Set<string>();
  const callRe = new RegExp(`(?<![\\w$.])${writer.replace(/\$/g, "\\$")}\\s*\\(`, "g");
  // Loop variables bound to literal tuples: for (const v of ["a", "b"] as const) { … }
  const loops: { variable: string; states: string[]; start: number; end: number }[] = [];
  for (const m of text.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+\[/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close === -1) continue;
    const states = stringLiterals(text.slice(open, close + 1));
    const bodyOpen = text.indexOf("{", close);
    const bodyClose = bodyOpen === -1 ? -1 : matchBracket(text, bodyOpen);
    if (bodyClose === -1) continue;
    loops.push({ variable: m[1]!, states, start: bodyOpen, end: bodyClose });
  }
  for (const m of text.matchAll(callRe)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close === -1) continue;
    const args = text.slice(open + 1, close);
    for (const s of stringLiterals(args)) covered.add(s);
    for (const loop of loops) {
      if (
        m.index! > loop.start &&
        m.index! < loop.end &&
        new RegExp(`(?<![\\w$])${loop.variable}(?![\\w$])`).test(args)
      ) {
        loop.states.forEach((s) => covered.add(s));
      }
    }
  }
  return covered;
}

function coveredBySql(file: string, text: string, column: string): Set<string> {
  const covered = new Set<string>();
  for (const st of scanStatements(file, text)) {
    if (st.kind === "update") {
      for (const m of st.sql.matchAll(new RegExp(`\\b${column}\\s*=\\s*'([^']+)'`, "g")))
        covered.add(m[1]!);
    } else if (st.kind === "insert" || st.kind === "replace") {
      const cols = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(st.sql);
      if (!cols) continue;
      const names = cols[1]!.split(",").map((c) => c.trim().replace(/["`[\]]/g, ""));
      const values = cols[2]!.split(",").map((v) => v.trim());
      const idx = names.indexOf(column);
      const v = idx === -1 ? undefined : values[idx];
      const lit = v ? /^'([^']+)'$/.exec(v) : null;
      if (lit) covered.add(lit[1]!);
    }
  }
  return covered;
}

export function auditStateTransitions(snapshot: TreeSnapshot): AuditorOutput {
  const machines = findStateMachines(snapshot);
  if (machines.length === 0) {
    return {
      findings: [],
      unverifiable: 0,
      skipped: ["state.transitions.coverage: no-declared-machine"],
    };
  }
  const findings: RawFinding[] = [];
  const codeFiles = [...snapshot.files].filter(
    ([f]) => /\.(?:ts|mts|tsx)$/.test(f) && !isTestFile(f),
  );
  for (const machine of machines) {
    const covered = new Set<string>();
    for (const [file, text] of codeFiles) {
      for (const writer of machine.writers)
        coveredByCalls(text, writer).forEach((s) => covered.add(s));
      if (machine.column) coveredBySql(file, text, machine.column).forEach((s) => covered.add(s));
    }
    for (const edge of machine.edges) {
      if (covered.has(edge.to)) continue;
      findings.push({
        check: "state.transitions.coverage",
        subject: `${machine.name}:${edge.from}→${edge.to}`,
        severity: "error",
        message: `declared edge ${edge.from} → ${edge.to} has no writer: no call of ${machine.writers.join("/") || "(no writers declared)"} receives "${edge.to}"${machine.column ? ` and no SQL sets ${machine.column} = '${edge.to}'` : ""}`,
        location: { file: machine.file, line: machine.line },
      });
    }
  }
  return { findings, unverifiable: 0, skipped: [] };
}
