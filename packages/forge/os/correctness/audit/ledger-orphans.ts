/*
<MODULE_CONTRACT>
<purpose>RFC-1579 CORR-AUDIT-02 `ledger.orphans` — every table a D1 schema
declares needs both a writer and a reader among the code statements
(migration INSERTs count as writes): `read-never-written` and
`written-never-read` are errors, `untouched` (declared, never read or
written) is a warning so a migration-first change does not block.</purpose>
<non-goals>
  <item>No allow-list decisions — differential.ts applies `correctness.audit.allow[]`.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial auditor.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import type { SchemaDiscovery } from "./schema-db.ts";
import { tableAccess, type SqlStatement } from "./sql-scanner.ts";
import type { TreeSnapshot } from "./snapshot.ts";
import type { AuditorOutput, RawFinding } from "./types.ts";

export function auditLedgerOrphans(
  discovery: SchemaDiscovery,
  statements: SqlStatement[],
  snapshot: TreeSnapshot,
): AuditorOutput {
  const findings: RawFinding[] = [];
  const declared = new Map<string, string>(); // table → first migration declaring it
  for (const schema of discovery.schemas) {
    for (const t of schema.tables) {
      if (declared.has(t)) continue;
      const decl = schema.migrations.find((m) =>
        new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\`[]?${t}\\b`, "i").test(
          snapshot.files.get(m) ?? "",
        ),
      );
      declared.set(t, decl ?? schema.configFile);
    }
  }
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const st of statements) {
    const access = tableAccess(st.sql);
    access.reads.forEach((t) => reads.add(t));
    access.writes.forEach((t) => writes.add(t));
  }
  for (const schema of discovery.schemas) {
    for (const m of schema.migrations) {
      const access = tableAccess(snapshot.files.get(m) ?? "");
      // Only seeding INSERTs count from migrations; DDL-time selects are not readers.
      for (const t of access.writes) {
        if (/\bINSERT\b/i.test(snapshot.files.get(m) ?? "")) writes.add(t);
      }
    }
  }
  for (const [table, source] of [...declared.entries()].sort()) {
    const r = reads.has(table);
    const w = writes.has(table);
    if (r && w) continue;
    const kind = r ? "read-never-written" : w ? "written-never-read" : "untouched";
    findings.push({
      check: "ledger.orphans",
      subject: table,
      severity: kind === "untouched" ? "warning" : "error",
      message:
        kind === "untouched"
          ? `untouched: declared in ${source}, no statement reads or writes it`
          : kind === "read-never-written"
            ? `read-never-written: statements read ${table} but nothing writes it (declared in ${source})`
            : `written-never-read: statements write ${table} but nothing reads it (declared in ${source})`,
      location: { file: source, line: 1 },
    });
  }
  return { findings, unverifiable: 0, skipped: [] };
}
