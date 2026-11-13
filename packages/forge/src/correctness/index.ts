/*
<MODULE_CONTRACT>
<purpose>RFC-1580: kernel-free test-side helpers (`@warpgogol/forge/correctness`)
an oracle calls so the correctness gate can see what it actually ran on —
`attestSubstrate` (schema hash of the handle used), `verifyAnchorEvents`
(`forge.anchor` log lines checked against that handle), `loadCapture`
(which capture files were loaded). Without `FORGE_CORRECTNESS_DIR` (ordinary
`pnpm test`) every helper is a no-op apart from its return value.</purpose>
<non-goals>
  <item>Never imported by product production code — anchor events are plain JSON log lines.</item>
  <item>No proof of how assertions used the handle — the bundle states that limitation.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Identifiers in anchor events must exist in the attested schema; values are bound as parameters, never interpolated.</item>
  <item>Results append to JSON files in the run directory; the gate never reuses a previous run's directory.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial helpers.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-05 findings

N1 bootstrap degrade only while the base has not adopted the contour (a forge downgrade refuses); N2 L3 on data/lifecycle counts at its attested level; N3 anchor events bound to the attested handle; N4 new support-glob files are frozen additions; N5/N6 isolated sessions may touch anchor files and only frozen forge.yaml keys; N7 RFC body amended; N8 regression tests; N9 run root in finally and grandchildren reaped; N10 every declared capture loaded. DEV-7 recorded; DEV-5 narrowed pending operator confirmation.</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { schemaHashOf, type SchemaHandle } from "./schema-hash.ts";

export { normalizeSchemaRows, schemaHashOf } from "./schema-hash.ts";
export type { SchemaHandle, SchemaRow } from "./schema-hash.ts";

export const ATTESTATION_FILE = "attestation.json";
export const ANCHOR_EVENTS_FILE = "anchor-events.json";
export const CAPTURES_FILE = "captures.json";

export interface SubstrateAttestation {
  level: "L1" | "L2";
  engine: string;
  schemaHash: string;
}

export interface AnchorEventResult {
  anchor: string;
  ok: boolean;
  reason?: string;
  /** Normalized schema hash of the handle the event was verified against. */
  schemaHash?: string;
}

function runDir(): string | null {
  const dir = process.env["FORGE_CORRECTNESS_DIR"];
  return dir && dir.length > 0 ? dir : null;
}

function appendJson(file: string, items: unknown[]): void {
  const dir = runDir();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, file);
  let current: unknown[] = [];
  if (existsSync(abs)) {
    try {
      const parsed = JSON.parse(readFileSync(abs, "utf8"));
      if (Array.isArray(parsed)) current = parsed;
    } catch {
      current = [];
    }
  }
  writeFileSync(abs, JSON.stringify([...current, ...items], null, 2));
}

/** L1/L2: hash the normalized live schema of the handle the oracle actually used. */
export function attestSubstrate(
  db: SchemaHandle,
  meta: { level: "L1" | "L2"; engine: string },
): SubstrateAttestation {
  const attestation: SubstrateAttestation = {
    level: meta.level,
    engine: meta.engine,
    schemaHash: schemaHashOf(db),
  };
  const dir = runDir();
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ATTESTATION_FILE), JSON.stringify(attestation, null, 2));
  }
  return attestation;
}

interface AnchorRef {
  table: string;
  key: Record<string, unknown>;
  column: string;
  value: unknown;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function columnsOf(db: SchemaHandle, table: string): Set<string> | null {
  const tables = (
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  if (!tables.includes(table)) return null;
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return new Set(cols.map((c) => c.name));
}

function verifyOne(db: SchemaHandle, anchor: string, ref: unknown): AnchorEventResult {
  const r = ref as Partial<AnchorRef> | null;
  if (
    !r ||
    typeof r.table !== "string" ||
    typeof r.column !== "string" ||
    !r.key ||
    typeof r.key !== "object"
  ) {
    return { anchor, ok: false, reason: "event ref needs table, key, column, value" };
  }
  const keyCols = Object.keys(r.key);
  if (keyCols.length === 0) return { anchor, ok: false, reason: "event ref key is empty" };
  for (const ident of [r.table, r.column, ...keyCols]) {
    if (!IDENT_RE.test(ident))
      return {
        anchor,
        ok: false,
        reason: `identifier ${JSON.stringify(ident)} is not a plain SQL name`,
      };
  }
  const cols = columnsOf(db, r.table);
  if (cols === null)
    return { anchor, ok: false, reason: `table ${r.table} is not in the attested schema` };
  for (const c of [r.column, ...keyCols]) {
    if (!cols.has(c))
      return { anchor, ok: false, reason: `column ${r.table}.${c} is not in the attested schema` };
  }
  const where = keyCols.map((c) => `"${c}" = ?`).join(" AND ");
  const rows = db
    .prepare(`SELECT "${r.column}" AS v FROM "${r.table}" WHERE ${where}`)
    .all(...keyCols.map((c) => (r.key as Record<string, unknown>)[c])) as { v: unknown }[];
  if (rows.length === 0)
    return { anchor, ok: false, reason: `no ${r.table} row matches ${JSON.stringify(r.key)}` };
  const matches = rows.some((row) => row.v === r.value || String(row.v) === String(r.value));
  return matches
    ? { anchor, ok: true }
    : {
        anchor,
        ok: false,
        reason: `${r.table}.${r.column} is ${JSON.stringify(rows[0]!.v)}, event claims ${JSON.stringify(r.value)}`,
      };
}

/** Collect `forge.anchor` events from captured output and verify each state reference against db. */
export function verifyAnchorEvents(
  lines: Iterable<string>,
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
): AnchorEventResult[] {
  const results: AnchorEventResult[] = [];
  for (const line of lines) {
    const start = line.indexOf("{");
    if (start === -1 || !line.includes("forge.anchor")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    const anchor = (event as Record<string, unknown>)?.["forge.anchor"];
    if (typeof anchor !== "string") continue;
    results.push({
      ...verifyOne(db, anchor, (event as Record<string, unknown>)["ref"]),
      schemaHash: schemaHashOf(db),
    });
  }
  appendJson(ANCHOR_EVENTS_FILE, results);
  return results;
}

/** Record which capture files the oracle loaded (provider seams); returns the parsed JSON. */
export function loadCapture(capturePath: string): unknown {
  const bytes = readFileSync(capturePath);
  const rel = path.relative(process.cwd(), path.resolve(capturePath)).replace(/\\/g, "/");
  appendJson(CAPTURES_FILE, [
    { path: rel, sha256: createHash("sha256").update(bytes).digest("hex") },
  ]);
  return JSON.parse(bytes.toString("utf8"));
}
