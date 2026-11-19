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
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import { ambientIo as fs } from "../../../src/utils/io.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

import {
  FRICTION_DIR,
  LEGACY_FRICTION_FILE,
  loadFrictionSources,
  writeFriction,
} from "../store.ts";
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

export async function runFrictionMigrate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FrictionMigrateResult>> {
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
