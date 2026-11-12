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
</CHANGE_SUMMARY>
*/

import { candidateSchemas, type SchemaDiscovery } from "./schema-db.ts";
import { tableAccess, type SqlStatement } from "./sql-scanner.ts";
import type { AuditorOutput, RawFinding } from "./types.ts";

const MISSING_RE = /no such (column|table): ([A-Za-z0-9_."]+)/i;

/** Best-effort table owning a missing column: the single table the statement names, else "?". */
function owningTable(sql: string, column: string): string {
  if (column.includes(".")) return column.split(".")[0]!;
  const names = [
    ...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi),
  ].map((m) => m[1]!.toLowerCase());
  const unique = [...new Set(names)];
  return unique.length === 1 ? unique[0]! : "?";
}

const IN_CODE_DDL_RE =
  /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi;

/**
 * Tables created by `CREATE TABLE` string literals in code (Durable Object or
 * embedded SQLite storage). They belong to a database no wrangler D1 binding
 * declares, so a statement naming one cannot be judged against D1.
 */
export function inCodeTables(literals: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of literals) {
    for (const m of text.matchAll(IN_CODE_DDL_RE)) out.add(m[1]!.toLowerCase());
  }
  return out;
}

export function auditSqlSchemaConform(
  discovery: SchemaDiscovery,
  statements: SqlStatement[],
  codeTables: Set<string> = new Set(),
): AuditorOutput {
  const findings: RawFinding[] = [];
  let unverifiable = 0;
  for (const f of discovery.failures) {
    findings.push({
      check: "sql.schema.conform",
      subject: f.migration,
      severity: "error",
      message: `migration does not apply: ${f.message}`,
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
    const missing = errors.map((e) => MISSING_RE.exec(e)).find((m) => m !== null);
    if (!missing) {
      unverifiable += 1;
      continue;
    }
    const kind = missing[1]!.toLowerCase();
    const name = missing[2]!.replace(/"/g, "");
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
        : `${st.file}:${owningTable(st.sql, name)}.${name.includes(".") ? name.split(".")[1] : name}`;
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
