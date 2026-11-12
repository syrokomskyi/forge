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
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial auditor.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import { candidateSchemas, type SchemaDiscovery } from "./schema-db.ts";
import type { SqlStatement } from "./sql-scanner.ts";
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

export function auditSqlSchemaConform(
  discovery: SchemaDiscovery,
  statements: SqlStatement[],
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
