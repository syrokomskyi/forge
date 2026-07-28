/*
<MODULE_CONTRACT>
<purpose>forge.upgrade — additive sync for npm consumers. Refreshes .agents/skills/
from the installed forge package, adds missing binding defaults (RFC-0540) without
overwriting operator-set values, updates forge.syncedVersion, and runs forge.doctor.</purpose>
<non-goals>
  <item>Do not overwrite operator-set non-null bindings — additive only.</item>
  <item>Do not create forge.yaml — that is forge.create's responsibility.</item>
  <item>Do not modify PREFERENCES.md or AGENTS.md — upgrade is skill + binding sync only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0543: initial forge.upgrade handler — 7-step additive sync flow.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import {
  FORGE_CLI_BINDING_DEFAULTS,
  resolveForgeRoot,
  loadForgeConfig,
  resolvePmRunner,
  type ForgeConfig,
  type ForgeBindings,
} from "../config/forge-config.ts";
import { FORGE_SKILLS, discoverPackSkills } from "../registry.ts";
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
  doctorReport: unknown;
}

function readForgePackageVersion(forgeRoot: string): string {
  const pkgPath = path.join(forgeRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0-unknown";
}

function syncForgeSkills(
  workspaceRoot: string,
  forgeRoot: string,
  skillsDir: string,
  dryRun: boolean,
): string[] {
  const updated: string[] = [];
  const agentsSkillsDir = path.join(workspaceRoot, skillsDir);

  for (const skill of FORGE_SKILLS) {
    const srcPath = path.join(forgeRoot, skill.path);
    if (!fs.existsSync(srcPath)) continue;

    const skillName = skill.name;
    const destDir = path.join(agentsSkillsDir, skillName);
    const destPath = path.join(destDir, "SKILL.md");

    if (!dryRun) {
      fs.mkdirSync(destDir, { recursive: true });
      const content = fs.readFileSync(srcPath, "utf8");
      fs.writeFileSync(destPath, content, "utf8");

      // Sync knowledge files
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
              if (fs.existsSync(kfSrcPath)) {
                fs.writeFileSync(kfDestPath, fs.readFileSync(kfSrcPath, "utf8"), "utf8");
              }
            }
          }
        } catch {
          // Frontmatter parse error — SKILL-01 will catch in validation
        }
      }
    }
    updated.push(skillName);
  }

  return updated;
}

function syncPackSkills(
  workspaceRoot: string,
  config: ForgeConfig,
  skillsDir: string,
  dryRun: boolean,
): { updated: string[]; skipped: SkippedSkill[] } {
  const updated: string[] = [];
  const skipped: SkippedSkill[] = [];
  const agentsSkillsDir = path.join(workspaceRoot, skillsDir);
  const packSkills = discoverPackSkills(workspaceRoot, config);
  const forgeSkillNames = new Set(FORGE_SKILLS.map((s) => s.name));

  for (const skill of packSkills) {
    const srcPath = path.join(workspaceRoot, skill.dir, skill.path);
    if (!fs.existsSync(srcPath)) continue;

    const skillName = skill.name;

    if (forgeSkillNames.has(skillName)) {
      skipped.push({ name: skillName, reason: "conflict with Forge skill" });
      continue;
    }

    const destDir = path.join(agentsSkillsDir, skillName);
    const destPath = path.join(destDir, "SKILL.md");

    if (!dryRun) {
      fs.mkdirSync(destDir, { recursive: true });
      const content = fs.readFileSync(srcPath, "utf8");
      fs.writeFileSync(destPath, content, "utf8");

      // Sync knowledge files
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
              if (fs.existsSync(kfSrcPath)) {
                fs.writeFileSync(kfDestPath, fs.readFileSync(kfSrcPath, "utf8"), "utf8");
              }
            }
          }
        } catch {
          // Frontmatter parse error
        }
      }
    }
    updated.push(skillName);
  }

  return { updated, skipped };
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

function updateSyncedVersion(
  workspaceRoot: string,
  config: ForgeConfig,
  version: string,
  dryRun: boolean,
): void {
  if (dryRun) return;

  // Set the syncedVersion on the in-memory config (bindings already updated)
  config.forge = { syncedVersion: version };

  // Write the full config back to forge.yaml
  const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
  fs.writeFileSync(forgeYamlPath, stringifyYaml(config), "utf8");
}

export async function runUpgrade(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<UpgradeResult>> {
  const { workspaceRoot, dryRun } = context;
  const isDryRun = dryRun || input.flags["dry-run"] === true;

  // Step 0: Check forge.yaml exists
  const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
  if (!fs.existsSync(forgeYamlPath)) {
    return {
      data: {
        command: "forge.upgrade",
        status: "fail",
        fromVersion: "",
        toVersion: "",
        skillsUpdated: [],
        bindingsAdded: [],
        skippedSkills: [],
        doctorReport: null,
      },
      nextSteps: [{ action: "Run 'forge create' to create forge.yaml first", kind: "required" }],
      exitCode: 1,
      summary: "[forge.upgrade] FAIL — forge.yaml not found. Run 'forge create' first.",
    };
  }

  // Step 1: Resolve forge root and read installed version
  let forgeRoot: string;
  let toVersion: string;
  try {
    forgeRoot = context.forgeRoot ?? resolveForgeRoot(workspaceRoot);
    toVersion = readForgePackageVersion(forgeRoot);
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
        doctorReport: null,
      },
      nextSteps: [
        { action: "Install @warpgogol/forge first: npm install @warpgogol/forge", kind: "required" },
      ],
      exitCode: 1,
      summary: `[forge.upgrade] FAIL — ${(err as Error).message}`,
    };
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
        doctorReport: null,
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
    // Noop — versions match
    const nextSteps: ForgeNextStep[] = [];
    return {
      data: {
        command: "forge.upgrade",
        status: "noop",
        fromVersion,
        toVersion,
        skillsUpdated: [],
        bindingsAdded: [],
        skippedSkills: [],
        doctorReport: null,
      },
      nextSteps,
      exitCode: 0,
      summary: `[forge.upgrade] Already up to date (v${toVersion})`,
    };
  }

  // Step 3: Sync forge skills
  const forgeSkillsUpdated = syncForgeSkills(
    workspaceRoot,
    forgeRoot,
    config.paths.skillsDir,
    isDryRun,
  );

  // Step 3b: Sync pack skills
  const packResult = syncPackSkills(
    workspaceRoot,
    config,
    config.paths.skillsDir,
    isDryRun,
  );

  const skillsUpdated = [...forgeSkillsUpdated, ...packResult.updated];

  // Step 4: Add missing binding defaults
  const bindingsAdded = addMissingBindingDefaults(config, isDryRun);

  // Step 5: Update forge.syncedVersion
  if (!isDryRun) {
    updateSyncedVersion(workspaceRoot, config, toVersion, false);
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
      skippedSkills: packResult.skipped,
      doctorReport,
    },
    nextSteps,
    exitCode: 0,
    summary: isDryRun
      ? `[dry-run] forge.upgrade: would sync ${skillsUpdated.length} skill(s), add ${bindingsAdded.length} binding(s), update syncedVersion to ${toVersion}`
      : `[forge.upgrade] OK — ${skillsUpdated.length} skill(s) synced, ${bindingsAdded.length} binding(s) added, syncedVersion → ${toVersion}`,
  };
}
