/*
<MODULE_CONTRACT>
<purpose>RFC-1579 CORR-AUDIT-01 `sql.schema.conform` — every static SQL
statement literal in non-test TypeScript must prepare against the real D1
schema its package owns (`node:sqlite` `prepare()`); `no such column` /
`no such table` are findings, a migration that fails to apply is a finding,
everything else (interpolated templates, D1-only syntax) is unverifiable.</purpose>
<non-goals>
  <item>Never execute statements — `prepare()` only.</item>
  <item>No partial schema — a failed migration makes its package's statements unverifiable.</item>
  <item>No judgement of in-code SQLite storage — a statement touching a table only a `CREATE TABLE` literal in code creates (Durable Object storage) is unverifiable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial auditor.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
  <item>RFC-1579: gate line, ecosystem.commit early run, reference page

typescript profile integration-gate.sh runs the primary install's correctness.audit against FLOW_BASE_SHA; werkstatt ecosystem.commit gains EC-34 (correctness.audit --staged, refuses introduced CORR-AUDIT-01..03, warns on CORR-AUDIT-04); in-code CREATE TABLE tables (Durable Object storage) are unverifiable instead of D1 findings; correctness.audit declares generates: []; reference page and agent guides.

Measured on werkstatt (rollout step 3): 7 wrangler D1 configs, ~10 s per run, 3 legacy sql.schema.conform findings (packages/warpgogol-billing-cloudflare against schemas outside the repo), 127 unverifiable statements, no state machines; CORR-AUDIT-04 present (verify equals test) — fixed by the werkstatt gate-wiring queue task.</item>
  <item>RFC-1579: close review REVIEW-CODE-2026-11-13-01 findings

F1 INSERT 'has no column named' is a finding; F2 severity/kind escalation since base is introduced; F3 unparseable machine tables are errors; F4 comma joins, string literals and comments in table extraction; F5 only migration INSERT/REPLACE seed writes; F6 SET-clause-only coverage; F7 method-call writers; F8 regex literals in the scanner; F9 alias resolution; F10 EC-34 judges the payload only; F11 EC-34 before the scoped gates with a dry-run line; F12/F13 config and YAML errors named; F14 config-only check skips snapshots; F15 git grep failures fail closed; F16 portable prefilter; F17 shell no-ops; F18 shared D1 schemas; in-code DDL scoped per package; ledger tests. DEV-1..DEV-4 recorded in the RFC Deviations section.</item>
</CHANGE_SUMMARY>
*/

import { candidateSchemas, type SchemaDiscovery } from "./schema-db.ts";
import { tableAccess, type SqlStatement } from "./sql-scanner.ts";
import type { AuditorOutput, RawFinding } from "./types.ts";

const MISSING_RE = /no such (column|table): ([A-Za-z0-9_."]+)/i;
// SQLite reports an INSERT column the table lacks with a different message.
const NO_COLUMN_NAMED_RE = /table ["`]?([A-Za-z0-9_]+)["`]? has no column named ([A-Za-z0-9_]+)/i;

/** Alias → table map from `FROM|JOIN <table> [AS] <alias>` (and `UPDATE <table>`). */
function aliasesOf(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /\b(?:FROM|JOIN|UPDATE|INTO)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/g;
  const keywords =
    /^(?:WHERE|SET|ON|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|GROUP|ORDER|LIMIT|VALUES|USING|RETURNING|UNION|SELECT|AND|OR)$/i;
  for (const m of sql.matchAll(re)) {
    const table = m[1]!.toLowerCase();
    out.set(table, table);
    if (m[2] && !keywords.test(m[2])) out.set(m[2].toLowerCase(), table);
  }
  return out;
}

/** Table owning a missing column: alias-qualified, else the single table the statement names, else "?". */
function owningTable(sql: string, column: string): string {
  const aliases = aliasesOf(sql);
  if (column.includes(".")) {
    const q = column.split(".")[0]!.toLowerCase();
    return aliases.get(q) ?? q;
  }
  const unique = [...new Set(aliases.values())];
  return unique.length === 1 ? unique[0]! : "?";
}

/** Package scope of a path: its first two segments (`packages/x`, `apps/y`), or "" at the root. */
export function packageScope(file: string): string {
  const parts = file.split("/");
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : "";
}

const IN_CODE_DDL_RE =
  /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi;

/**
 * Tables created by `CREATE TABLE` string literals in code (Durable Object or
 * embedded SQLite storage), keyed by package scope. They belong to a database
 * no wrangler D1 binding declares, so a statement in the same package that
 * touches one cannot be judged against D1.
 */
export function inCodeTables(literals: { file: string; text: string }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { file, text } of literals) {
    const scope = packageScope(file);
    const set = out.get(scope) ?? new Set<string>();
    for (const m of text.matchAll(IN_CODE_DDL_RE)) set.add(m[1]!.toLowerCase());
    out.set(scope, set);
  }
  return out;
}

export function auditSqlSchemaConform(
  discovery: SchemaDiscovery,
  statements: SqlStatement[],
  codeTablesByScope: Map<string, Set<string>> = new Map(),
): AuditorOutput {
  const findings: RawFinding[] = [];
  let unverifiable = 0;
  for (const f of discovery.failures) {
    findings.push({
      check: "sql.schema.conform",
      subject: f.migration,
      severity: "error",
      message:
        f.kind === "config"
          ? `wrangler config unreadable: ${f.message}`
          : `migration does not apply: ${f.message}`,
      location: { file: f.migration, line: 1 },
    });
  }
  for (const st of statements) {
    const failedOwner = [...discovery.failedPackages].some(
      (dir) => dir === "" || st.file.startsWith(`${dir}/`),
    );
    const candidates = candidateSchemas(discovery.schemas, st.file);
    if (st.interpolated || failedOwner || candidates.length === 0) {
      unverifiable += 1;
      continue;
    }
    const errors: string[] = [];
    let prepared = false;
    for (const schema of candidates) {
      try {
        schema.db.prepare(st.sql);
        prepared = true;
        break;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    if (prepared) continue;
    // A finding only when it fails against every candidate with a missing name.
    let kind: "column" | "table" | null = null;
    let name = "";
    let tableHint: string | null = null;
    for (const e of errors) {
      const m = MISSING_RE.exec(e);
      if (m) {
        kind = m[1]!.toLowerCase() as "column" | "table";
        name = m[2]!.replace(/"/g, "");
        break;
      }
      const n = NO_COLUMN_NAMED_RE.exec(e);
      if (n) {
        kind = "column";
        tableHint = n[1]!.toLowerCase();
        name = n[2]!;
        break;
      }
    }
    if (kind === null) {
      unverifiable += 1;
      continue;
    }
    const codeTables = codeTablesByScope.get(packageScope(st.file)) ?? new Set<string>();
    // A statement touching an in-code-DDL table that no candidate D1 schema
    // declares targets another database — unverifiable, never a finding.
    const access = tableAccess(st.sql);
    const touched = [...access.reads, ...access.writes];
    if (touched.some((t) => codeTables.has(t) && !candidates.some((c) => c.tables.has(t)))) {
      unverifiable += 1;
      continue;
    }
    const subject =
      kind === "table"
        ? `${st.file}:${name.toLowerCase()}`
        : `${st.file}:${tableHint ?? owningTable(st.sql, name)}.${name.includes(".") ? name.split(".")[1] : name}`;
    findings.push({
      check: "sql.schema.conform",
      subject,
      severity: "error",
      message: `no such ${kind}: ${name}`,
      location: { file: st.file, line: st.line },
    });
  }
  return { findings, unverifiable, skipped: [] };
}
