/*
<MODULE_CONTRACT>
<purpose>friction.migrate command handler (RFC-1590) — splits the legacy
single-file registry at docs/frictions.yaml into per-record files under
docs/frictions/F-NNNN.yaml, removes the legacy file in the same run, and
moves every .agents/skills/<skill>/qa-log.md to qa-log/legacy.md.
Idempotent: no legacy file and no qa-log.md files reports migrated: 0.</purpose>
<non-goals>
  <item>No schema repair — entries that cannot be named (missing or
  malformed id) refuse the run; fix the registry first.</item>
  <item>No canonical-skill migration — canonical skill trees are source
  edits; this command covers the runtime .agents/skills surface every
  consumer workshop shares.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Records land before the legacy file removes — a failed write never leaves a half-split registry.</item>
  <item>A qa-log.md reappearing after qa-log/legacy.md exists merges in
  chronological order (existing legacy first) — never silently drops the
  older log.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1590: friction.migrate — legacy split + removal, qa-log.md
  shard moves under .agents/skills/, --dry-run reporting.</item>
  <item>RFC-1590: store append-only shared ledgers as one file per record</item>
  <item>RFC-1639: step 3-4 — friction.migrate --from ingest, friction.add --level, CREATE-SUPERFOLDER-01 guard</item>
  <item>RFC-1639: review — SYSTEM-MAP-01 rules decl, git-probe warnings, sibling kind/path discriminants, friction.add provenance, ingest hardening</item>
</CHANGE_SUMMARY>
*/

import path, { join } from "node:path";

import { parse as yamlParse } from "yaml";

import { ambientIo as fs } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

import { reserveNextGovernanceId } from "../../rfc/next-id.ts";
import {
  FRICTION_DIR,
  LEGACY_FRICTION_FILE,
  defaultSession,
  frictionSourceMax,
  loadFrictionSources,
  writeFriction,
} from "../store.ts";
import { FRICTION_ID_PATTERN } from "../types.ts";
import type { FrictionEntry } from "../types.ts";

export interface FrictionMigrateResult {
  command: "friction.migrate";
  status: "pass" | "fail";
  dryRun: boolean;
  migrated: number;
  files: string[];
  legacyRemoved: boolean;
  qaLogMoved: string[];
  qaLogMerged: string[];
  skipped: Array<{ id: string | null; reason: string }>;
  errors: Diagnostic[];
}

const QA_LOG_GLOB_ROOT = ".agents/skills";

/** RFC-1590: the per-session shard path inside a skill's qa-log/ directory —
 * the single naming rule sessions, migrate, and readers share. Session ids
 * are branch names (`auto/session-…`), so path-hostile characters flatten
 * to hyphens; `"legacy"` is the reserved shard migrate writes. */
export function qaLogShardPath(skillRelDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return join(skillRelDir, "qa-log", `${safe || "session"}.md`);
}

/** Every `.agents/skills/<skill>/qa-log.md` present — a readdir scan so
 * fake-io test harnesses without glob() still work. */
async function listQaLogFiles(root: string): Promise<string[]> {
  const skillsDir = join(root, QA_LOG_GLOB_ROOT);
  if (!(await fs.exists(skillsDir))) return [];
  const found: string[] = [];
  for (const entry of await fs.readdir(skillsDir)) {
    if (!entry.isDirectory) continue;
    const candidate = join(QA_LOG_GLOB_ROOT, entry.name, "qa-log.md");
    if (await fs.exists(join(root, candidate))) found.push(candidate);
  }
  return found;
}

function flag(input: ForgeCommandInput, name: string): string | undefined {
  const v = input.flags[name];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

export async function runFrictionMigrate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FrictionMigrateResult>> {
  // RFC-1639: --from ingests an EXTERNAL legacy frictions.yaml into this
  // workspace's registry — the superfolder-level file lands inside the
  // system hub at the next F-ids with migratedFrom+origin provenance.
  const from = flag(input, "from");
  if (from !== undefined) {
    return runIngest(input, context, from);
  }

  const { workspaceRoot, logger, outputFormat } = context;
  const dryRun = input.flags["dry-run"] === true;
  const files: string[] = [];
  const qaLogMoved: string[] = [];
  const qaLogMerged: string[] = [];
  const skipped: Array<{ id: string | null; reason: string }> = [];
  const errors: Diagnostic[] = [];

  const sources = await loadFrictionSources(workspaceRoot, fs);

  // ── legacy split ─────────────────────────────────────────────────────
  let migrated = 0;
  let legacyRemoved = false;
  if (sources.legacy.length > 0) {
    // Entries must be nameable — a record without a readable id cannot
    // produce a file name, so the run refuses before touching anything.
    const unnameable = sources.legacy.filter((r) => r.id === null);
    for (const rec of unnameable) {
      errors.push({
        ruleId: "FRICTION-01",
        severity: "error",
        message: `legacy entry at index ${sources.legacy.indexOf(rec)} carries no readable id — repair the registry before migrating`,
        file: LEGACY_FRICTION_FILE,
      });
    }
    // Records that failed the entry schema still migrate (the file holds
    // what the file held — friction.validate owns integrity reporting).
    const nameable = sources.legacy.filter((r): r is typeof r & { id: string } => r.id !== null);

    if (unnameable.length === 0) {
      for (const rec of nameable) {
        const file = join(FRICTION_DIR, `${rec.id}.yaml`);
        files.push(file);
        if (dryRun) continue;
        try {
          await writeFriction(workspaceRoot, rec.raw as FrictionEntry, fs);
          migrated++;
        } catch (e) {
          errors.push({
            ruleId: "FRICTION-01",
            severity: "error",
            message: e instanceof Error ? e.message : String(e),
            file,
          });
          break;
        }
      }
      if (errors.length === 0 && !dryRun) {
        await fs.rm(join(workspaceRoot, LEGACY_FRICTION_FILE));
        legacyRemoved = true;
      }
    }
  }

  // ── qa-log sharding ──────────────────────────────────────────────────
  const qaLogs = await listQaLogFiles(workspaceRoot);
  for (const rel of qaLogs) {
    const legacyTarget = qaLogShardPath(join(rel, ".."), "legacy");
    const absTarget = join(workspaceRoot, legacyTarget);
    const absSource = join(workspaceRoot, rel);
    if (dryRun) {
      qaLogMoved.push(rel);
      continue;
    }
    if (await fs.exists(absTarget)) {
      // The legacy shard already exists — the reappeared qa-log.md holds
      // newer entries: append after the existing shard, keeping order.
      const merged = `${await fs.readFile(absTarget)}\n\n${await fs.readFile(absSource)}`;
      await fs.writeFile(absTarget, merged);
      await fs.rm(absSource);
      qaLogMerged.push(rel);
    } else {
      await fs.rename(absSource, absTarget);
      qaLogMoved.push(rel);
    }
  }

  const status = errors.length === 0 ? "pass" : "fail";
  const data: FrictionMigrateResult = {
    command: "friction.migrate",
    status,
    dryRun,
    migrated,
    files,
    legacyRemoved,
    qaLogMoved,
    qaLogMerged,
    skipped,
    errors,
  };

  if (outputFormat === "pretty") {
    logger.section("friction.migrate");
    if (sources.legacy.length === 0) {
      logger.info(`  ${LEGACY_FRICTION_FILE} absent — nothing to split`);
    } else {
      logger.info(
        `  ${LEGACY_FRICTION_FILE} → ${files.length} record file(s) under ${FRICTION_DIR}/` +
          (dryRun ? " (dry-run)" : `, legacy ${legacyRemoved ? "removed" : "kept"}`),
      );
    }
    if (qaLogs.length > 0) {
      logger.info(
        `  qa-log.md → qa-log/legacy.md: ${qaLogMoved.length} moved, ${qaLogMerged.length} merged`,
      );
    }
    for (const e of errors) logger.error(`  ${e.ruleId}: ${e.message}`);
  }

  return {
    data,
    summary:
      sources.legacy.length === 0 && qaLogs.length === 0
        ? "friction.migrate: migrated: 0"
        : `friction.migrate: ${migrated}/${files.length} records split, ${qaLogMoved.length + qaLogMerged.length} qa-log shard(s)${dryRun ? " (dry-run)" : ""}`,
    exitCode: errors.length === 0 ? 0 : 1,
  };
}

// ── --from ingest (RFC-1639) ─────────────────────────────────────────────

/**
 * Ingest an external legacy frictions.yaml into this workspace's registry.
 * Records mint at the next ids via the shared git-dir ledger (never
 * dir-scan), carry migratedFrom + origin + level provenance, and the source
 * file is removed last so a crash-interrupted re-run re-derives the same
 * mapping and skips already-ingested entries.
 */
async function runIngest(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
  fromRaw: string,
): Promise<ForgeCommandResult<FrictionMigrateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const dryRun = input.flags["dry-run"] === true;
  const files: string[] = [];
  const skipped: Array<{ id: string | null; reason: string }> = [];
  const errors: Diagnostic[] = [];
  let migrated = 0;
  let legacyRemoved = false;

  const finish = (summary: string): ForgeCommandResult<FrictionMigrateResult> => ({
    data: {
      command: "friction.migrate",
      status: errors.length === 0 ? "pass" : "fail",
      dryRun,
      migrated,
      files,
      legacyRemoved,
      qaLogMoved: [],
      qaLogMerged: [],
      skipped,
      errors,
    },
    summary,
    exitCode: errors.length === 0 ? 0 : 1,
  });
  const refuse = (message: string): ForgeCommandResult<FrictionMigrateResult> => {
    errors.push({ ruleId: "FRICTION-01", severity: "error", message, file: fromRaw });
    return finish(`friction.migrate --from refused: ${message}`);
  };

  const resolved = path.isAbsolute(fromRaw)
    ? path.normalize(fromRaw)
    : path.resolve(workspaceRoot, fromRaw);
  const rootNorm = path.resolve(workspaceRoot);
  if (resolved === rootNorm || resolved.startsWith(rootNorm + path.sep)) {
    return refuse(
      "--from must point outside the workspace — the no-flag path owns docs/frictions.yaml",
    );
  }
  if (!(await fs.exists(resolved))) {
    return refuse(`source file not found: ${resolved}`);
  }

  // origin — the source registry's dir basename, unwrapping a trailing
  // docs/ so <repo>/docs/frictions.yaml records origin as <repo>.
  const parent = path.dirname(resolved);
  const origin =
    path.basename(parent) === "docs" ? path.basename(path.dirname(parent)) : path.basename(parent);
  if (origin.length === 0) {
    return refuse(
      `cannot derive an origin name from ${resolved} — pass a file inside a named folder`,
    );
  }

  const levelFlag = flag(input, "level");
  if (levelFlag !== undefined && levelFlag !== "repo" && levelFlag !== "folder") {
    errors.push({
      ruleId: "FRICTION-03",
      severity: "error",
      message: `level "${levelFlag}" is outside the closed catalog (repo, folder)`,
      file: fromRaw,
    });
    return finish(`friction.migrate --from refused: invalid --level ${levelFlag}`);
  }

  // Parse — accept both legacy shapes ({entries: [...]} and a bare array).
  let rows: Record<string, unknown>[];
  try {
    const parsed = yamlParse(await fs.readFile(resolved)) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed !== null &&
          typeof parsed === "object" &&
          Array.isArray((parsed as Record<string, unknown>)["entries"])
        ? ((parsed as Record<string, unknown>)["entries"] as unknown[])
        : null;
    if (list === null) {
      return refuse(`${resolved} is not a legacy frictions registry (no entries array)`);
    }
    rows = list as Record<string, unknown>[];
  } catch (e) {
    return refuse(
      `${resolved} is not readable YAML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Every row must name an F-NNNN id — the run refuses before writing when
  // one cannot be renumbered deterministically.
  for (const [i, row] of rows.entries()) {
    const id = row?.["id"];
    if (typeof id !== "string" || !FRICTION_ID_PATTERN.test(id)) {
      return refuse(
        `source entry at index ${i} carries no readable F-NNNN id — repair the source registry before ingesting`,
      );
    }
  }

  const sources = await loadFrictionSources(workspaceRoot, fs);
  const ingested = new Set(
    sources.dir
      .map((r) => r.raw as Record<string, unknown> | undefined)
      .filter(
        (r): r is Record<string, unknown> =>
          r !== undefined && r["origin"] === origin && typeof r["migratedFrom"] === "string",
      )
      .map((r) => r["migratedFrom"] as string),
  );

  let max = frictionSourceMax(sources);
  const session = flag(input, "session") ?? (await defaultSession(workspaceRoot, fs));
  const level = levelFlag === "repo" ? ("repo" as const) : ("folder" as const);

  for (const row of rows) {
    const oldId = row["id"] as string;
    if (ingested.has(oldId)) {
      skipped.push({ id: oldId, reason: `already ingested (origin: ${origin})` });
      continue;
    }
    if (dryRun) {
      files.push(join(FRICTION_DIR, `F-${String(max + 1).padStart(4, "0")}.yaml`));
      max += 1;
      continue;
    }
    const allocation = await reserveNextGovernanceId(fs, workspaceRoot, "friction", max, session);
    max = Math.max(max, allocation.id);
    const id = `F-${String(allocation.id).padStart(4, "0")}`;
    const file = join(FRICTION_DIR, `${id}.yaml`);
    files.push(file);
    const record = {
      ...row,
      id,
      migratedFrom: oldId,
      origin,
      level,
    } as FrictionEntry;
    try {
      await writeFriction(workspaceRoot, record, fs);
      migrated++;
      ingested.add(oldId);
      for (const w of allocation.warnings) {
        if (outputFormat === "pretty") logger.warn(`  ${w}`);
      }
    } catch (e) {
      errors.push({
        ruleId: "FRICTION-01",
        severity: "error",
        message: e instanceof Error ? e.message : String(e),
        file,
      });
      break;
    }
  }

  // Source removal is LAST — a crash before this point re-runs cleanly.
  if (!dryRun && errors.length === 0) {
    try {
      await fs.rm(resolved);
      legacyRemoved = true;
    } catch (e) {
      errors.push({
        ruleId: "FRICTION-01",
        severity: "error",
        message: `records written but the source could not be removed: ${e instanceof Error ? e.message : String(e)}`,
        file: resolved,
      });
    }
  }

  if (outputFormat === "pretty") {
    logger.section("friction.migrate --from");
    logger.info(
      `  ${resolved} → ${files.length} record(s) under ${FRICTION_DIR}/ (origin: ${origin})` +
        (dryRun ? " (dry-run)" : `, source ${legacyRemoved ? "removed" : "kept"}`),
    );
    for (const s of skipped) logger.info(`  skipped ${s.id}: ${s.reason}`);
    for (const e of errors) logger.error(`  ${e.ruleId}: ${e.message}`);
  }

  return finish(
    `friction.migrate --from: ${migrated} record(s) ingested from ${origin}${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}${dryRun ? " (dry-run)" : ""}`,
  );
}
