/*
<MODULE_CONTRACT>
<purpose>RFC-1580: normalized live-schema hash shared by the test-side
attestation helper and the correctness gate — `SELECT type, name, sql FROM
sqlite_schema`, engine tables dropped (`sqlite_%`, `_cf_%`, `d1_migrations`),
whitespace collapsed, trailing semicolons stripped, sorted by type and name,
sha256 over the rows. Miniflare / local D1 handles hash like node:sqlite.</purpose>
<non-goals>
  <item>No kernel or forge-os imports — this module ships in the test-side export.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial normalization.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";

export interface SchemaRow {
  type: string;
  name: string;
  sql: string | null;
}

/** Minimal handle shape: better-sqlite3, node:sqlite, and D1-over-miniflare adapters all fit. */
export interface SchemaHandle {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const ENGINE_NAME_RE = /^(?:sqlite_|_cf_)|^d1_migrations$/i;

export function normalizeSchemaRows(rows: SchemaRow[]): string {
  return rows
    .filter((r) => !ENGINE_NAME_RE.test(r.name))
    .map((r) => ({
      type: r.type,
      name: r.name,
      sql: (r.sql ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/;+\s*$/, ""),
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    .map((r) => `${r.type}\t${r.name}\t${r.sql}`)
    .join("\n");
}

export function schemaRowsOf(db: SchemaHandle): SchemaRow[] {
  return db.prepare("SELECT type, name, sql FROM sqlite_schema").all() as SchemaRow[];
}

export function schemaHashOf(db: SchemaHandle): string {
  return createHash("sha256")
    .update(normalizeSchemaRows(schemaRowsOf(db)))
    .digest("hex");
}
