/*
<MODULE_CONTRACT>
<purpose>forge.upgrade — additive sync for npm consumers. Refreshes .agents/skills/
from the installed forge package, adds missing binding defaults (RFC-0540) without
overwriting operator-set values, updates forge.syncedVersion, and runs forge.doctor.
With --update-npm, also updates @warpgogol/forge from npm before syncing (skipped in monorepo).</purpose>
<non-goals>
  <item>Do not overwrite operator-set non-null bindings — additive only.</item>
  <item>Do not create forge.yaml — that is forge.create's responsibility.</item>
  <item>Do not modify PREFERENCES.md or AGENTS.md — upgrade is skill + binding sync only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <item>RFC-1224: preserve operator forge.yaml content on upgrade, promote adrImplementStamp binding</item>
  <item>fix: sync skills/_shared/ convention docs to .agents/skills/_shared/ — fo-* SKILL.md references dangled for npm consumers</item>
  <item>Knowledge conflicts land in .forge/knowledge-conflicts.txt (summary + path in console instead of a 60+ entry dump); exposed as knowledgeConflicts/knowledgeConflictsReport on UpgradeResult. Prettierignore plan now enumerates generated AGENTS.md paths.</item>
  <history>RFC-0543, RFC-0611, RFC-0663, RFC-0664, RFC-1224</history>
</CHANGE_SUMMARY>
*/

import type { WorkspaceIO } from "../types.ts";
import { resolveIo } from "../utils/io.ts";
import { hasGeneratedMarker, mergeEditableGenerated } from "../utils/index.ts";
import path from "node:path";

import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import {
  FORGE_CLI_BINDING_DEFAULTS,
  resolveForgeRoot,
  loadForgeConfig,
  serializeForgeConfig,
  applyForgeYamlPatches,
  resolvePmRunner,
  resolvePmInstall,
  type ForgeConfig,
  type ForgeBindings,
  type ForgeYamlPatch,
} from "../config/forge-config.ts";
import { FORGE_SKILLS, discoverPackSkills } from "../registry.ts";
import { syncKnowledgeFile } from "../knowledge/index.ts";
import { writeFileIfChanged } from "../utils/fs-idempotent.ts";
import {
  writeSkillMarker,
  pruneStaleSkillDirs,
  listFilesRecursive,
  type PruneResult,
} from "./skill-markers.ts";
import {
  planPrettierignore,
  applyPrettierignore,
  type PrettierignoreResult,
} from "./prettierignore.ts";
import { generateNestedAgentsMd } from "./nested-agents-generate.ts";
import { resolveWorkspaceTypes } from "./workspace-discovery.ts";
import { scaffoldMemoryLayer } from "./memory-scaffold.ts";
import type { SkippedSkill } from "./init.ts";
import type { ForgeCommandInput, ForgeCommandResult, ForgeNextStep, ForgeRuntimeContext } from "../types.ts";

export interface UpgradeResult {
  command: "forge.upgrade";
  status: "pass" | "noop" | "fail";
  fromVersion: string;
  toVersion: string;
  skillsUpdated: string[];
  bindingsAdded: { key: string; value: string }[];
  skippedSkills: SkippedSkill[];
  nestedAgentsGenerated: string[];
  /** RFC-1153: dry-run only — nested guides whose merged output differs from disk. */
  nestedAgentsPlanned: string[];
  /** RFC-1153: files merged with a carried custom tail below the boundary. */
  nestedAgentsPreserved: string[];
  /** RFC-1153: hand-written or unmapped files skipped by the merge. */
  nestedAgentsSkipped: string[];
  memoryScaffold: { created: string[]; gitignoreUpdated: boolean; skipped: string[] };
  npmUpdated: boolean;
  npmUpdateSkipped: string | null;
  latestNpmVersion: string | null;
  npmVersionWarning: string | null;
  doctorReport: unknown;
  // RFC-1154: reconcile phase results (runs on every upgrade incl. noop).
  skillsPruned: string[];
  skillsKeptWithConsumerFiles: string[];
  prettierignore: PrettierignoreResult;
  /** Knowledge entries diverging between package and project — local kept. */
  knowledgeConflicts?: string[];
  /** Repo-relative path of the written conflicts report, when any. */
  knowledgeConflictsReport?: string | null;
}

async function isMonorepoForge(workspaceRoot: string, io: WorkspaceIO): Promise<boolean> {
  return io.exists(path.join(workspaceRoot, "packages", "forge", "package.json"));
}

async function updateNpmPackage(
  workspaceRoot: string,
  config: ForgeConfig,
  isDryRun: boolean,
  io: WorkspaceIO,
): Promise<{ updated: boolean; skipped: string | null }> {
  if (await isMonorepoForge(workspaceRoot, io)) {
    return { updated: false, skipped: "monorepo (local package, not npm-installed)" };
  }

  const pm = config.project.packageManager;
  const installCmd = resolvePmInstall(pm);
  const installArgs = installCmd.split(/\s+/);

  if (isDryRun) {
    return { updated: false, skipped: "dry-run" };
  }

  const result = await io
    .exec(installArgs[0]!, [...installArgs.slice(1), "@warpgogol/forge@latest"], {
      cwd: workspaceRoot,
      timeoutMs: 120_000,
    })
    .catch(() => null);
  if (result && result.exitCode === 0) {
    return { updated: true, skipped: null };
  }
  return { updated: false, skipped: "install failed (network error or registry unavailable)" };
}

async function readForgePackageVersion(forgeRoot: string, io: WorkspaceIO): Promise<string> {
  const pkgPath = path.join(forgeRoot, "package.json");
  const pkg = JSON.parse(await io.readFile(pkgPath)) as { version?: string };
  return pkg.version ?? "0.0.0-unknown";
}

async function checkLatestNpmVersion(
  workspaceRoot: string,
  installedVersion: string,
  isMonorepo: boolean,
  io: WorkspaceIO,
): Promise<{ latest: string | null; warning: string | null }> {
  if (isMonorepo) {
    return { latest: null, warning: null };
  }
  try {
    const result = await io.exec("npm", ["view", "@warpgogol/forge", "version"], {
      cwd: workspaceRoot,
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "npm view failed");
    const latest = result.stdout.trim();
    if (!latest || !/^\d+\.\d+\.\d+/.test(latest)) {
      return { latest: null, warning: null };
    }
    if (latest !== installedVersion) {
      const pm = (() => {
        try {
          const config = loadForgeConfig(workspaceRoot);
          return resolvePmInstall(config.project.packageManager);
        } catch {
          return "npm install";
        }
      })();
      return {
        latest,
        warning: `Forge ${installedVersion} is installed, but ${latest} is available on npm. Run: ${pm} @warpgogol/forge@latest`,
      };
    }
    return { latest, warning: null };
  } catch {
    return { latest: null, warning: null };
  }
}

async function syncForgeSkills(
  workspaceRoot: string,
  forgeRoot: string,
  skillsDir: string,
  dryRun: boolean,
  io: WorkspaceIO,
): Promise<{ updated: string[]; knowledgeConflicts: string[] }> {
  const updated: string[] = [];
  const knowledgeConflicts: string[] = [];
  const agentsSkillsDir = path.join(workspaceRoot, skillsDir);

  for (const skill of FORGE_SKILLS) {
    const srcPath = path.join(forgeRoot, skill.path);
    if (!(await io.exists(srcPath))) continue;

    const skillName = skill.name;
    const destDir = path.join(agentsSkillsDir, skillName);
    const destPath = path.join(destDir, "SKILL.md");

    if (!dryRun) {
      await io.mkdir(destDir);
      const content = await io.readFile(srcPath);
      await writeFileIfChanged(destPath, content, io);

      // RFC-1154: marker manifest lists SKILL.md + knowledge files that carry
      // pure forge content. Merged/skipped knowledge files hold consumer
      // entries — excluded so a stale dir is kept rather than deleted.
      const markerFiles = ["SKILL.md"];

      // Sync knowledge files (append-only — never overwrite local entries)
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        try {
          const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
          const knowledgeFiles = fm["knowledge"];
          if (Array.isArray(knowledgeFiles)) {
            const skillSrcDir = path.dirname(srcPath);
            for (const kf of knowledgeFiles) {
              if (typeof kf !== "string") continue;
              const kfSrcPath = path.join(skillSrcDir, kf);
              const kfDestPath = path.join(destDir, kf);
              if (await io.exists(kfSrcPath)) {
                const syncResult = syncKnowledgeFile(kfSrcPath, kfDestPath);
                for (const id of syncResult.conflicts) {
                  knowledgeConflicts.push(`${skillName}/${kf}#${id}`);
                }
                if (syncResult.action === "copied" || syncResult.action === "unchanged") {
                  markerFiles.push(kf);
                }
              }
            }
          }
        } catch {
          // Frontmatter parse error — SKILL-01 will catch in validation
        }
      }
      await writeSkillMarker(destDir, markerFiles, io);
    }
    updated.push(skillName);
  }

  return { updated, knowledgeConflicts };
}

async function syncSharedKnowledge(
  workspaceRoot: string,
  forgeRoot: string,
  skillsDir: string,
  dryRun: boolean,
  io: WorkspaceIO,
): Promise<{ updated: string[]; knowledgeConflicts: string[] }> {
  const updated: string[] = [];
  const knowledgeConflicts: string[] = [];
  const srcPath = path.join(forgeRoot, "skills", "shared", "knowledge", "learned-principles.md");
  if (!(await io.exists(srcPath))) return { updated, knowledgeConflicts };

  const destDir = path.join(workspaceRoot, skillsDir, "shared-knowledge");
  const destPath = path.join(destDir, "learned-principles.md");

  if (!dryRun) {
    await io.mkdir(destDir);
    const syncResult = syncKnowledgeFile(srcPath, destPath);
    for (const id of syncResult.conflicts) {
      knowledgeConflicts.push(`shared-knowledge/learned-principles.md#${id}`);
    }
    // RFC-1154: marker lists the file only when its content is purely forge's.
    const markerFiles =
      syncResult.action === "copied" || syncResult.action === "unchanged"
        ? ["learned-principles.md"]
        : [];
    await writeSkillMarker(destDir, markerFiles, io);
  }
  updated.push("shared-knowledge");
  return { updated, knowledgeConflicts };
}

/**
 * Sync `_shared/` convention docs (fo-pipeline-conventions.md et al.) into
 * `.agents/skills/_shared/`. fo-* SKILL.md files link these by relative path —
 * without the copy the references dangle for npm consumers. Verbatim sync like
 * SKILL.md, forge-managed via marker so a dropped upstream dir prunes cleanly.
 */
async function syncSharedConventions(
  workspaceRoot: string,
  forgeRoot: string,
  skillsDir: string,
  dryRun: boolean,
  io: WorkspaceIO,
): Promise<{ updated: string[] }> {
  const srcDir = path.join(forgeRoot, "skills", "_shared");
  if (!(await io.exists(srcDir))) return { updated: [] };

  const files = await listFilesRecursive(srcDir, io);
  if (files.length === 0) return { updated: [] };

  if (!dryRun) {
    const destDir = path.join(workspaceRoot, skillsDir, "_shared");
    await io.mkdir(destDir);
    for (const rel of files) {
      const content = await io.readFile(path.join(srcDir, rel));
      await writeFileIfChanged(path.join(destDir, rel), content, io);
    }
    await writeSkillMarker(destDir, files, io);
  }
  return { updated: ["_shared"] };
}

async function syncPackSkills(
  workspaceRoot: string,
  config: ForgeConfig,
  skillsDir: string,
  dryRun: boolean,
  io: WorkspaceIO,
): Promise<{ updated: string[]; skipped: SkippedSkill[]; knowledgeConflicts: string[] }> {
  const updated: string[] = [];
  const skipped: SkippedSkill[] = [];
  const knowledgeConflicts: string[] = [];
  const agentsSkillsDir = path.join(workspaceRoot, skillsDir);
  let packSkills: ReturnType<typeof discoverPackSkills> = [];
  try {
    packSkills = discoverPackSkills(workspaceRoot, config);
  } catch {
    // Manifest missing or invalid — skip pack skill sync
  }
  const forgeSkillNames = new Set(FORGE_SKILLS.map((s) => s.name));

  for (const skill of packSkills) {
    const srcPath = path.join(workspaceRoot, skill.dir, skill.path);
    if (!(await io.exists(srcPath))) continue;

    const skillName = skill.name;

    if (forgeSkillNames.has(skillName)) {
      skipped.push({ name: skillName, reason: "conflict with Forge skill" });
      continue;
    }

    const destDir = path.join(agentsSkillsDir, skillName);
    const destPath = path.join(destDir, "SKILL.md");

    if (!dryRun) {
      await io.mkdir(destDir);
      const content = await io.readFile(srcPath);
      await writeFileIfChanged(destPath, content, io);

      // RFC-1154: same marker rule as forge skills — merged/skipped knowledge
      // files carry consumer entries and are excluded from the manifest.
      const markerFiles = ["SKILL.md"];

      // Sync knowledge files (append-only — never overwrite local entries)
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        try {
          const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
          const knowledgeFiles = fm["knowledge"];
          if (Array.isArray(knowledgeFiles)) {
            const skillSrcDir = path.dirname(srcPath);
            for (const kf of knowledgeFiles) {
              if (typeof kf !== "string") continue;
              const kfSrcPath = path.join(skillSrcDir, kf);
              const kfDestPath = path.join(destDir, kf);
              if (await io.exists(kfSrcPath)) {
                const syncResult = syncKnowledgeFile(kfSrcPath, kfDestPath);
                for (const id of syncResult.conflicts) {
                  knowledgeConflicts.push(`${skillName}/${kf}#${id}`);
                }
                if (syncResult.action === "copied" || syncResult.action === "unchanged") {
                  markerFiles.push(kf);
                }
              }
            }
          }
        } catch {
          // Frontmatter parse error
        }
      }
      await writeSkillMarker(destDir, markerFiles, io);
    }
    updated.push(skillName);
  }

  return { updated, skipped, knowledgeConflicts };
}

/**
 * RFC-1154 reconcile phase — runs on every forge upgrade, including the
 * same-version noop path: markers for synced dirs, prune stale marked dirs,
 * managed .prettierignore block. Idempotent; dry-run passes through.
 */
async function reconcileGeneratedSurface(
  workspaceRoot: string,
  forgeRoot: string,
  config: ForgeConfig,
  dryRun: boolean,
  io: WorkspaceIO,
): Promise<{
  updated: string[];
  knowledgeConflicts: string[];
  skipped: SkippedSkill[];
  prune: PruneResult;
  prettierignore: PrettierignoreResult;
  /** Non-fatal reconcile failures — surface as warnings, never block upgrade. */
  warnings: string[];
}> {
  const forgeSkillsResult = await syncForgeSkills(
    workspaceRoot,
    forgeRoot,
    config.paths.skillsDir,
    dryRun,
    io,
  );
  const packResult = await syncPackSkills(workspaceRoot, config, config.paths.skillsDir, dryRun, io);
  const sharedKnowledgeResult = await syncSharedKnowledge(
    workspaceRoot,
    forgeRoot,
    config.paths.skillsDir,
    dryRun,
    io,
  );
  const sharedConventionsResult = await syncSharedConventions(
    workspaceRoot,
    forgeRoot,
    config.paths.skillsDir,
    dryRun,
    io,
  );

  const currentSyncSet = new Set([
    ...forgeSkillsResult.updated,
    ...packResult.updated,
    ...sharedKnowledgeResult.updated,
    ...sharedConventionsResult.updated,
  ]);

  const warnings: string[] = [];

  let prune: PruneResult = { pruned: [], keptWithConsumerFiles: [] };
  if (!dryRun) {
    try {
      prune = await pruneStaleSkillDirs(
        path.join(workspaceRoot, config.paths.skillsDir),
        currentSyncSet,
        io,
      );
    } catch (err) {
      warnings.push(`stale skill dir prune failed: ${(err as Error).message}`);
    }
  }

  let prettierignore: PrettierignoreResult = "skipped";
  if (!dryRun) {
    try {
      prettierignore = await applyPrettierignore(
        workspaceRoot,
        await planPrettierignore(workspaceRoot, config.paths.skillsDir, io, {
          workspaceTypes: resolveWorkspaceTypes(config, forgeRoot),
          workspaceSkipDirs: config.bindings?.workspaces?.skipDirs,
        }),
        io,
      );
    } catch (err) {
      warnings.push(`.prettierignore reconcile failed: ${(err as Error).message}`);
    }
  }

  return {
    updated: [
      ...forgeSkillsResult.updated,
      ...packResult.updated,
      ...sharedKnowledgeResult.updated,
      ...sharedConventionsResult.updated,
    ],
    knowledgeConflicts: [
      ...forgeSkillsResult.knowledgeConflicts,
      ...packResult.knowledgeConflicts,
      ...sharedKnowledgeResult.knowledgeConflicts,
    ],
    skipped: packResult.skipped,
    prune,
    prettierignore,
    warnings,
  };
}

/**
 * Knowledge-conflict report — the full divergence list lands in
 * `.forge/knowledge-conflicts.txt` (overwritten each run, no churn); the
 * console keeps a one-line summary + path instead of a 60+ entry dump.
 */
async function writeKnowledgeConflictsReport(
  workspaceRoot: string,
  conflicts: string[],
  io: WorkspaceIO,
): Promise<string | null> {
  const rel = ".forge/knowledge-conflicts.txt";
  try {
    await io.writeFile(
      path.join(workspaceRoot, rel),
      [
        "# forge.upgrade knowledge conflicts — local project versions were kept.",
        "# Review and merge the package entries manually, then delete this file.",
        `# generated: ${new Date().toISOString()}`,
        "",
        ...conflicts.map((c) => `- ${c}`),
        "",
      ].join("\n"),
    );
    return rel;
  } catch {
    return null;
  }
}

async function reportKnowledgeConflicts(
  workspaceRoot: string,
  conflicts: string[],
  isDryRun: boolean,
  io: WorkspaceIO,
  logger: ForgeRuntimeContext["logger"],
): Promise<string | null> {
  if (conflicts.length === 0) return null;
  const reportPath = isDryRun ? null : await writeKnowledgeConflictsReport(workspaceRoot, conflicts, io);
  logger.warn(
    `forge.upgrade: ${conflicts.length} knowledge entr${conflicts.length === 1 ? "y" : "ies"} ` +
      `diverge between package and project — local versions kept` +
      (reportPath ? `; list: ${reportPath}` : ""),
  );
  return reportPath;
}

function addMissingBindingDefaults(
  config: ForgeConfig,
  dryRun: boolean,
): { key: string; value: string }[] {
  if (!config.bindings) return [];

  const pm = config.project.packageManager;
  const runner = resolvePmRunner(pm);
  const added: { key: string; value: string }[] = [];

  for (const entry of FORGE_CLI_BINDING_DEFAULTS) {
    const bareKey = entry.key.replace("commands.", "") as keyof ForgeBindings["commands"];
    const currentValue = config.bindings.commands[bareKey];

    if (currentValue === null || currentValue === undefined) {
      const resolvedValue = `${runner} ${entry.template}`;
      added.push({ key: entry.key, value: resolvedValue });

      if (!dryRun) {
        config.bindings.commands[bareKey] = resolvedValue;
      }
    }
  }

  return added;
}

async function updateSyncedVersion(
  workspaceRoot: string,
  config: ForgeConfig,
  version: string,
  bindingsAdded: { key: string; value: string }[],
  dryRun: boolean,
  io: WorkspaceIO,
  warn: (msg: string) => void,
): Promise<void> {
  if (dryRun) return;

  // Keep the in-memory config truthful for downstream steps (doctor).
  config.forge = { syncedVersion: version };

  // RFC-1224: patch the existing document — syncedVersion plus newly added
  // binding defaults — instead of re-serializing, so consumer-owned keys,
  // sections, comments and ordering survive the rewrite.
  const patches: ForgeYamlPatch[] = [
    { path: ["forge", "syncedVersion"], value: version },
    ...bindingsAdded.map((b) => ({
      path: ["bindings", ...b.key.split(".")],
      value: b.value,
    })),
  ];
  const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
  const raw = await io.readFile(forgeYamlPath).catch(() => null);
  const patched = raw === null ? null : applyForgeYamlPatches(raw, patches);
  if (patched !== null) {
    await io.writeFile(forgeYamlPath, patched);
    return;
  }
  warn(
    "forge.upgrade: forge.yaml patch failed — falling back to full serialization (schema-unknown keys may be dropped)",
  );
  // RFC-1118: serializeForgeConfig writes the declared profile id verbatim —
  // never the resolved StackProfile object, never drops an unresolvable id.
  await io.writeFile(forgeYamlPath, stringifyYaml(serializeForgeConfig(config)));
}

export async function runUpgrade(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<UpgradeResult>> {
  const { workspaceRoot, dryRun } = context;
  const fio = resolveIo(context.io);
  const isDryRun = dryRun || input.flags["dry-run"] === true;
  const isUpdateNpm = input.flags["update-npm"] === true;

  // Step 0: Check forge.yaml exists
  const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
  if (!(await fio.exists(forgeYamlPath))) {
    return {
      data: {
        command: "forge.upgrade",
        status: "fail",
        fromVersion: "",
        toVersion: "",
        skillsUpdated: [],
        bindingsAdded: [],
        skippedSkills: [],
        nestedAgentsGenerated: [],
        nestedAgentsPlanned: [],
        nestedAgentsPreserved: [],
        nestedAgentsSkipped: [],
        memoryScaffold: { created: [], gitignoreUpdated: false, skipped: [] },
        npmUpdated: false,
        npmUpdateSkipped: null,
        latestNpmVersion: null,
        npmVersionWarning: null,
        doctorReport: null,
        skillsPruned: [],
        skillsKeptWithConsumerFiles: [],
        prettierignore: "skipped",
      },
      nextSteps: [{ action: "Run 'forge create' to create forge.yaml first", kind: "required" }],
      exitCode: 1,
      summary: "[forge.upgrade] FAIL — forge.yaml not found. Run 'forge create' first.",
    };
  }

  // Step 0.5: Update npm package if --update-npm flag is set
  let npmUpdated = false;
  let npmUpdateSkipped: string | null = null;
  if (isUpdateNpm) {
    let configForNpm: ForgeConfig;
    try {
      configForNpm = loadForgeConfig(workspaceRoot);
    } catch {
      configForNpm = { project: { packageManager: "npm" } } as unknown as ForgeConfig;
    }
    const npmResult = await updateNpmPackage(workspaceRoot, configForNpm, isDryRun, fio);
    npmUpdated = npmResult.updated;
    npmUpdateSkipped = npmResult.skipped;
  }

  // Step 1: Resolve forge root and read installed version
  let forgeRoot: string;
  let toVersion: string;
  try {
    forgeRoot = context.forgeRoot ?? resolveForgeRoot(workspaceRoot);
    toVersion = await readForgePackageVersion(forgeRoot, fio);
  } catch (err) {
    return {
      data: {
        command: "forge.upgrade",
        status: "fail",
        fromVersion: "",
        toVersion: "",
        skillsUpdated: [],
        bindingsAdded: [],
        skippedSkills: [],
        nestedAgentsGenerated: [],
        nestedAgentsPlanned: [],
        nestedAgentsPreserved: [],
        nestedAgentsSkipped: [],
        memoryScaffold: { created: [], gitignoreUpdated: false, skipped: [] },
        npmUpdated: false,
        npmUpdateSkipped: null,
        latestNpmVersion: null,
        npmVersionWarning: null,
        doctorReport: null,
        skillsPruned: [],
        skillsKeptWithConsumerFiles: [],
        prettierignore: "skipped",
      },
      nextSteps: [
        { action: "Install @warpgogol/forge first: npm install @warpgogol/forge", kind: "required" },
      ],
      exitCode: 1,
      summary: `[forge.upgrade] FAIL — ${(err as Error).message}`,
    };
  }

  // Step 1.5: Check npm for newer version (non-fatal)
  const npmCheck = await checkLatestNpmVersion(workspaceRoot, toVersion, await isMonorepoForge(workspaceRoot, fio), fio);
  if (npmCheck.warning && context.outputFormat === "pretty") {
    context.logger.warn(`⚠ ${npmCheck.warning}`);
  }

  // Step 2: Load config and check syncedVersion
  let config: ForgeConfig;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch (err) {
    return {
      data: {
        command: "forge.upgrade",
        status: "fail",
        fromVersion: "",
        toVersion,
        skillsUpdated: [],
        bindingsAdded: [],
        skippedSkills: [],
        nestedAgentsGenerated: [],
        nestedAgentsPlanned: [],
        nestedAgentsPreserved: [],
        nestedAgentsSkipped: [],
        memoryScaffold: { created: [], gitignoreUpdated: false, skipped: [] },
        npmUpdated: false,
        npmUpdateSkipped: null,
        latestNpmVersion: npmCheck.latest,
        npmVersionWarning: npmCheck.warning,
        doctorReport: null,
        skillsPruned: [],
        skillsKeptWithConsumerFiles: [],
        prettierignore: "skipped",
      },
      nextSteps: [
        { action: `Fix forge.yaml: ${(err as Error).message}`, kind: "required" },
      ],
      exitCode: 1,
      summary: `[forge.upgrade] FAIL — forge.yaml invalid: ${(err as Error).message}`,
    };
  }

  const fromVersion = config.forge?.syncedVersion ?? null;

  if (fromVersion === toVersion) {
    // Noop version-wise — but the RFC-1154 reconcile (markers, stale-dir prune,
    // managed .prettierignore) still runs so a same-version upgrade fixes lint debt.
    const reconcile = await reconcileGeneratedSurface(
      workspaceRoot,
      forgeRoot,
      config,
      isDryRun,
      fio,
    );
    for (const kept of reconcile.prune.keptWithConsumerFiles) {
      context.logger.warn(`forge.upgrade: kept stale skill dir ${kept}`);
    }
    for (const warn of reconcile.warnings) {
      context.logger.warn(`forge.upgrade: ${warn}`);
    }
    const noopConflictsReport = await reportKnowledgeConflicts(
      workspaceRoot,
      reconcile.knowledgeConflicts,
      isDryRun,
      fio,
      context.logger,
    );
    return {
      data: {
        command: "forge.upgrade",
        status: "noop",
        fromVersion,
        toVersion,
        skillsUpdated: reconcile.updated,
        bindingsAdded: [],
        skippedSkills: reconcile.skipped,
        nestedAgentsGenerated: [],
        nestedAgentsPlanned: [],
        nestedAgentsPreserved: [],
        nestedAgentsSkipped: [],
        memoryScaffold: { created: [], gitignoreUpdated: false, skipped: [] },
        npmUpdated: npmUpdated,
        npmUpdateSkipped: npmUpdateSkipped,
        latestNpmVersion: npmCheck.latest,
        npmVersionWarning: npmCheck.warning,
        doctorReport: null,
        skillsPruned: reconcile.prune.pruned,
        skillsKeptWithConsumerFiles: reconcile.prune.keptWithConsumerFiles,
        prettierignore: reconcile.prettierignore,
        knowledgeConflicts: reconcile.knowledgeConflicts,
        knowledgeConflictsReport: noopConflictsReport,
      },
      nextSteps: npmCheck.warning
        ? [{ action: npmCheck.warning, kind: "optional" }]
        : [],
      exitCode: 0,
      summary: npmCheck.warning
        ? `[forge.upgrade] Already up to date (v${toVersion}) — ⚠ ${npmCheck.warning}`
        : `[forge.upgrade] Already up to date (v${toVersion})`,
    };
  }

  // Step 3: RFC-1154 reconcile — sync forge+pack skills + shared knowledge,
  // write .forge-managed markers, prune stale marked dirs, reconcile the
  // managed .prettierignore block.
  const reconcile = await reconcileGeneratedSurface(
    workspaceRoot,
    forgeRoot,
    config,
    isDryRun,
    fio,
  );

  const skillsUpdated = reconcile.updated;
  const knowledgeConflicts = reconcile.knowledgeConflicts;
  const packSkipped = reconcile.skipped;
  for (const kept of reconcile.prune.keptWithConsumerFiles) {
    context.logger.warn(`forge.upgrade: kept stale skill dir ${kept}`);
  }
  for (const warn of reconcile.warnings) {
    context.logger.warn(`forge.upgrade: ${warn}`);
  }
  const knowledgeConflictsReport = await reportKnowledgeConflicts(
    workspaceRoot,
    knowledgeConflicts,
    isDryRun,
    fio,
    context.logger,
  );

  // Step 3d: Scaffold memory layer (RFC-0664)
  const memoryScaffold = isDryRun ? { created: [], gitignoreUpdated: false, skipped: [] } : scaffoldMemoryLayer(workspaceRoot);

  // Step 4: Add missing binding defaults
  const bindingsAdded = addMissingBindingDefaults(config, isDryRun);

  // Step 5: Update forge.syncedVersion
  if (!isDryRun) {
    await updateSyncedVersion(
      workspaceRoot,
      config,
      toVersion,
      bindingsAdded,
      false,
      fio,
      (msg) => context.logger.warn(msg),
    );
  }

  // Step 5b: Generate nested AGENTS.md (RFC-0611). RFC-1153: the write path
  // merges at the forge:custom boundary, and --dry-run previews which guides
  // would be rewritten vs. skipped (the destructive step is no longer silent).
  let nestedAgentsGenerated: string[] = [];
  const nestedAgentsPlanned: string[] = [];
  let nestedAgentsPreserved: string[] = [];
  const nestedAgentsSkipped: string[] = [];
  try {
    const nestedResult = await generateNestedAgentsMd(workspaceRoot, config, isDryRun, undefined, fio);
    if (isDryRun) {
      for (const [relPath, rendered] of Object.entries(nestedResult.renderedFiles)) {
        const absPath = path.join(workspaceRoot, relPath);
        let existing: string | null = null;
        if (await fio.exists(absPath)) {
          try {
            existing = await fio.readFile(absPath);
          } catch {
            // Unreadable — treat as absent; merge will emit a fresh file.
          }
        }
        if (existing !== null && !hasGeneratedMarker(existing)) {
          nestedAgentsSkipped.push(`${relPath} (hand-written)`);
          continue;
        }
        const merged = mergeEditableGenerated(rendered, existing, relPath);
        if (merged === null) {
          nestedAgentsSkipped.push(`${relPath} (unmapped-customization)`);
        } else if (merged !== existing) {
          nestedAgentsPlanned.push(relPath);
        }
      }
    } else {
      nestedAgentsGenerated = nestedResult.generated;
      nestedAgentsPreserved = nestedResult.preserved;
      nestedAgentsSkipped.push(...nestedResult.skipped);
    }
  } catch {
    // Nested generation failure is non-fatal
  }

  // Step 6: Run doctor
  let doctorReport: unknown = null;
  if (!isDryRun) {
    try {
      const { runDoctor } = await import("./doctor.ts");
      const doctorResult = await runDoctor(input, context);
      doctorReport = doctorResult.data;
    } catch {
      // Doctor may fail in some contexts — non-fatal
    }
  }

  // Step 7: Build nextSteps
  const nextSteps: ForgeNextStep[] = [];
  if (isDryRun) {
    nextSteps.push({ action: "Re-run without --dry-run to apply changes", kind: "required" });
  } else {
    nextSteps.push({ action: "Review updated skills in .agents/skills/", kind: "optional" });
    if (bindingsAdded.length > 0) {
      nextSteps.push({
        action: "Review newly added binding defaults in forge.yaml",
        kind: "optional",
      });
    }
  }

  const status: UpgradeResult["status"] = "pass";

  return {
    data: {
      command: "forge.upgrade",
      status,
      fromVersion: fromVersion ?? "never-synced",
      toVersion,
      skillsUpdated,
      bindingsAdded,
      skippedSkills: packSkipped,
      nestedAgentsGenerated,
      nestedAgentsPlanned,
      nestedAgentsPreserved,
      nestedAgentsSkipped,
      memoryScaffold,
      npmUpdated,
      npmUpdateSkipped,
      latestNpmVersion: npmCheck.latest,
      npmVersionWarning: npmCheck.warning,
      doctorReport,
      skillsPruned: reconcile.prune.pruned,
      skillsKeptWithConsumerFiles: reconcile.prune.keptWithConsumerFiles,
      prettierignore: reconcile.prettierignore,
      knowledgeConflicts,
      knowledgeConflictsReport,
    },
    nextSteps,
    exitCode: 0,
    summary: isDryRun
      ? `[dry-run] forge.upgrade: would sync ${skillsUpdated.length} skill(s), add ${bindingsAdded.length} binding(s), update syncedVersion to ${toVersion}, rewrite ${nestedAgentsPlanned.length} nested AGENTS.md file(s)`
      : npmCheck.warning
        ? `[forge.upgrade] OK — ${skillsUpdated.length} skill(s) synced, ${bindingsAdded.length} binding(s) added, syncedVersion → ${toVersion} — ⚠ ${npmCheck.warning}`
        : `[forge.upgrade] OK — ${skillsUpdated.length} skill(s) synced, ${bindingsAdded.length} binding(s) added, syncedVersion → ${toVersion}` +
          (knowledgeConflicts.length > 0
            ? ` — ${knowledgeConflicts.length} knowledge conflict(s), local kept`
            : ""),
  };
}
