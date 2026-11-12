/*
<MODULE_CONTRACT>
<purpose>RFC-1579: D1 schema discovery — every `d1_databases` binding of a
wrangler.json / wrangler.jsonc in the snapshot yields one schema keyed by
`database_name`: its `migrations_dir` (default `migrations/`, relative to the
config's directory) is applied in filename order to its own in-memory
`node:sqlite` database. Databases are never merged; a migration that fails
to apply is reported instead of falling back to a partial schema.</purpose>
<non-goals>
  <item>No wrangler.toml support in v1 — reported as unsupported-config.</item>
  <item>No new runtime dependency — JSONC is stripped by the built-in stripper.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial per-database schema builder.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createRequire } from "node:module";

import { stripJsonc } from "./sql-scanner.ts";
import { isWranglerConfig, type TreeSnapshot } from "./snapshot.ts";

const require = createRequire(import.meta.url);

/** Load node:sqlite without its one-time ExperimentalWarning reaching stderr. */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

export interface D1Schema {
  /** `database_name` of the binding. */
  name: string;
  /** Workspace-relative POSIX directory of the wrangler config ("" = repo root). */
  packageDir: string;
  configFile: string;
  migrations: string[];
  db: DatabaseSyncType;
  /** Base tables (no sqlite_/_cf_/d1_migrations engine tables, no FTS shadows), lower-cased. */
  tables: Set<string>;
}

export interface MigrationFailure {
  migration: string;
  message: string;
}

export interface SchemaDiscovery {
  schemas: D1Schema[];
  failures: MigrationFailure[];
  unsupported: string[];
  /** Package dirs whose config or migrations failed — their statements are unverifiable. */
  failedPackages: Set<string>;
}

interface D1Binding {
  database_name?: unknown;
  migrations_dir?: unknown;
}

function d1Bindings(config: unknown): D1Binding[] {
  if (!config || typeof config !== "object") return [];
  const out: D1Binding[] = [];
  const top = (config as { d1_databases?: unknown }).d1_databases;
  if (Array.isArray(top)) out.push(...(top as D1Binding[]));
  const envs = (config as { env?: unknown }).env;
  if (envs && typeof envs === "object") {
    for (const env of Object.values(envs as Record<string, unknown>)) {
      const list = (env as { d1_databases?: unknown })?.d1_databases;
      if (Array.isArray(list)) out.push(...(list as D1Binding[]));
    }
  }
  return out;
}

const ENGINE_TABLE_RE = /^(?:sqlite_|_cf_)|^d1_migrations$/i;

function baseTables(db: DatabaseSyncType): Set<string> {
  const rows = db.prepare("PRAGMA table_list").all() as {
    name: string;
    type: string;
    schema: string;
  }[];
  return new Set(
    rows
      .filter((r) => r.schema === "main" && r.type === "table" && !ENGINE_TABLE_RE.test(r.name))
      .map((r) => r.name.toLowerCase()),
  );
}

/** Discover and build every D1 schema of a snapshot. */
export function discoverSchemas(snapshot: TreeSnapshot): SchemaDiscovery {
  const { DatabaseSync } = loadSqlite();
  const schemas: D1Schema[] = [];
  const failures: MigrationFailure[] = [];
  const unsupported: string[] = [];
  const failedPackages = new Set<string>();
  const configs = [...snapshot.files.keys()].filter(isWranglerConfig).sort();
  for (const configFile of configs) {
    if (configFile.endsWith(".toml")) {
      unsupported.push(configFile);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonc(snapshot.files.get(configFile)!));
    } catch (err) {
      failures.push({
        migration: configFile,
        message: `wrangler config is not valid JSON(C): ${(err as Error).message}`,
      });
      failedPackages.add(
        path.posix.dirname(configFile) === "." ? "" : path.posix.dirname(configFile),
      );
      continue;
    }
    const packageDir = path.posix.dirname(configFile) === "." ? "" : path.posix.dirname(configFile);
    const seen = new Set<string>();
    for (const binding of d1Bindings(parsed)) {
      const name = typeof binding.database_name === "string" ? binding.database_name : null;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const dirRel =
        typeof binding.migrations_dir === "string" ? binding.migrations_dir : "migrations";
      const migrationsDir = path.posix
        .normalize(path.posix.join(packageDir, dirRel))
        .replace(/^\.\//, "");
      const prefix = migrationsDir === "." ? "" : `${migrationsDir}/`;
      const migrations = [...snapshot.files.keys()]
        .filter(
          (f) =>
            f.endsWith(".sql") && f.startsWith(prefix) && !f.slice(prefix.length).includes("/"),
        )
        .sort((a, b) => path.posix.basename(a).localeCompare(path.posix.basename(b)));
      const db = new DatabaseSync(":memory:");
      let ok = true;
      for (const migration of migrations) {
        try {
          db.exec(snapshot.files.get(migration)!);
        } catch (err) {
          failures.push({ migration, message: (err as Error).message });
          ok = false;
          break;
        }
      }
      if (!ok) {
        db.close();
        failedPackages.add(packageDir);
        continue;
      }
      schemas.push({ name, packageDir, configFile, migrations, db, tables: baseTables(db) });
    }
  }
  return { schemas, failures, unsupported, failedPackages };
}

/** Candidate schemas of a statement in `file`: its package's schemas, or every schema outside any. */
export function candidateSchemas(schemas: D1Schema[], file: string): D1Schema[] {
  const owning = schemas
    .filter((s) => s.packageDir === "" || file.startsWith(`${s.packageDir}/`))
    .sort((a, b) => b.packageDir.length - a.packageDir.length);
  if (owning.length === 0) return schemas;
  const deepest = owning[0]!.packageDir;
  // A root-level config only owns files that no deeper config claims.
  return owning.filter((s) => s.packageDir === deepest);
}

export function closeSchemas(discovery: SchemaDiscovery): void {
  for (const s of discovery.schemas) {
    try {
      s.db.close();
    } catch {
      // already closed
    }
  }
}
