/*
<MODULE_CONTRACT>
<purpose>forge.doctor — diagnoses forge state in an existing project.
Checks for forge.yaml, AGENTS.md, PREFERENCES.md, .agents/skills/, docs/rfcs/,
@gogol/* import autonomy guard, and bindings contract (RFC-0393).</purpose>
<non-goals>
  <item>Do not modify files — doctor is read-only diagnostics.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial forge.doctor handler for autonomy refactor.</item>
  <item>RFC-0391: added @gogol/* forbidden-imports autonomy guard.</item>
  <item>RFC-0393: added bindings validation — resolved/absent/invalid reporting.</item>
  <item>RFC-0524: added stale knowledge file detection — compares source and .agents/ copies.</item>
  <item>RFC-0539: extended knowledge file check to iterate pack skills via discoverPackSkills. Added pack-skills check for stale/missing copies and skillPacks config validation.</item>
  <item>RFC-0540: added defaultable-binding-null notices for forge-CLI-backed bindings.</item>
</CHANGE_SUMMARY>
*/

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../types.ts";
import { resolveForgeRoot, loadForgeConfig, resolveBinding, FORGE_CLI_BINDING_DEFAULTS, resolvePmRunner } from "../config/forge-config.ts";
import { FORGE_SKILLS, discoverPackSkills } from "../registry.ts";

interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

interface ForbiddenImport {
  file: string;
  specifier: string;
}

interface BindingValidation {
  resolved: string[];
  absent: string[];
  invalid: string[];
  notices: BindingNotice[];
}

interface BindingNotice {
  key: string;
  rule: string;
  suggestion: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const FORBIDDEN_IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import\s+[^;]+?\s+from\s+|require\s*\(\s*)["'`](@gogol\/[^"'`]+)["'`]/g;

async function scanForForbiddenImports(
  dir: string,
  workspaceRoot: string,
): Promise<ForbiddenImport[]> {
  const violations: ForbiddenImport[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "tests") continue;
      const sub = await scanForForbiddenImports(fullPath, workspaceRoot);
      violations.push(...sub);
    } else if (entry.name.endsWith(".ts")) {
      const content = await readFile(fullPath, "utf8").catch(() => "");
      let match: RegExpExecArray | null;
      const pattern = new RegExp(FORBIDDEN_IMPORT_PATTERN.source, "g");
      while ((match = pattern.exec(content)) !== null) {
        violations.push({
          file: relative(workspaceRoot, fullPath),
          specifier: match[1],
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Bindings validation (RFC-0393)
// ---------------------------------------------------------------------------

const BINDING_PATH_KEYS = [
  "paths.invariantsFile",
  "paths.reviewsDir",
  "paths.handoffsDir",
  "paths.sessionsDir",
];

const BINDING_COMMAND_KEYS = [
  "commands.validateRfc",
  "commands.validateAdr",
  "commands.implementStamp",
  "commands.typecheck",
  "commands.test",
  "commands.scopedBuild",
  "commands.specValidate",
];

async function validateBindings(workspaceRoot: string): Promise<BindingValidation> {
  const result: BindingValidation = { resolved: [], absent: [], invalid: [], notices: [] };

  let config;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch {
    return result;
  }

  if (!config.bindings) {
    return result;
  }

  for (const key of BINDING_PATH_KEYS) {
    const value = resolveBinding(config, key);
    if (value === null) {
      result.absent.push(key);
    } else if (typeof value === "string") {
      const exists = await pathExists(join(workspaceRoot, value));
      if (exists) {
        result.resolved.push(key);
      } else {
        result.invalid.push(`${key} (path not found: ${value})`);
      }
    }
  }

  const compassDocs = resolveBinding(config, "paths.compassDocs");
  if (Array.isArray(compassDocs) && compassDocs.length > 0) {
    for (const docPath of compassDocs) {
      const exists = await pathExists(join(workspaceRoot, docPath));
      if (exists) {
        result.resolved.push(`paths.compassDocs[${docPath}]`);
      } else {
        result.invalid.push(`paths.compassDocs[${docPath}] (path not found)`);
      }
    }
  } else {
    result.absent.push("paths.compassDocs");
  }

  for (const key of BINDING_COMMAND_KEYS) {
    const value = resolveBinding(config, key);
    if (value === null) {
      result.absent.push(key);
    } else if (typeof value === "string") {
      result.resolved.push(key);
    }
  }

  // RFC-0540: Emit defaultable-binding-null notices for forge-CLI-backed bindings
  const pm = config.project.packageManager;
  const runner = resolvePmRunner(pm);
  for (const entry of FORGE_CLI_BINDING_DEFAULTS) {
    const value = resolveBinding(config, entry.key);
    if (value === null) {
      result.notices.push({
        key: entry.key,
        rule: "defaultable-binding-null",
        suggestion: `${runner} ${entry.template}`,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stale knowledge file detection (RFC-0524)
// ---------------------------------------------------------------------------

async function checkStaleKnowledgeFiles(
  workspaceRoot: string,
  forgeRoot: string,
): Promise<DoctorCheck> {
  const stale: string[] = [];

  let config;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch {
    return { name: "knowledge-files", status: "pass", message: "No forge.yaml — knowledge file check skipped" };
  }

  const agentsSkillsDir = join(workspaceRoot, config.paths.skillsDir);

  for (const skill of FORGE_SKILLS) {
    if (!skill.knowledge || skill.knowledge.length === 0) continue;

    const skillSrcDir = dirname(join(forgeRoot, skill.path));

    for (const kf of skill.knowledge) {
      const srcPath = join(skillSrcDir, kf);
      const destPath = join(agentsSkillsDir, skill.name, kf);

      const srcExists = await pathExists(srcPath);
      const destExists = await pathExists(destPath);

      if (srcExists && destExists) {
        const srcContent = await readFile(srcPath, "utf8").catch(() => "");
        const destContent = await readFile(destPath, "utf8").catch(() => "");
        if (srcContent !== destContent) {
          stale.push(`${skill.name}/${kf}`);
        }
      }
      // If source exists but dest doesn't, skip — expected on first install
      // If source doesn't exist, SKILL-13 in forge.skill.validate catches it
    }
  }

  // RFC-0539: Check pack skill knowledge files
  const packSkills = discoverPackSkills(workspaceRoot, config);
  for (const skill of packSkills) {
    if (!skill.knowledge || skill.knowledge.length === 0) continue;

    const skillSrcDir = dirname(join(workspaceRoot, skill.dir, skill.path));

    for (const kf of skill.knowledge) {
      const srcPath = join(skillSrcDir, kf);
      const destPath = join(agentsSkillsDir, skill.name, kf);

      const srcExists = await pathExists(srcPath);
      const destExists = await pathExists(destPath);

      if (srcExists && destExists) {
        const srcContent = await readFile(srcPath, "utf8").catch(() => "");
        const destContent = await readFile(destPath, "utf8").catch(() => "");
        if (srcContent !== destContent) {
          stale.push(`${skill.name}/${kf}`);
        }
      }
    }
  }

  return {
    name: "knowledge-files",
    status: stale.length === 0 ? "pass" : "warn",
    message:
      stale.length === 0
        ? "All knowledge files in sync"
        : `${stale.length} stale knowledge file(s): ${stale.join(", ")} — run 'forge create' to sync`,
  };
}

// ---------------------------------------------------------------------------
// Pack skill diagnostics (RFC-0539)
// ---------------------------------------------------------------------------

async function checkPackSkills(workspaceRoot: string): Promise<DoctorCheck> {
  let config;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch {
    return { name: "pack-skills", status: "pass", message: "No forge.yaml — pack skill check skipped" };
  }

  if (!config.skillPacks || config.skillPacks.length === 0) {
    return { name: "pack-skills", status: "pass", message: "No skill packs declared" };
  }

  const issues: string[] = [];

  // Validate skillPacks config: unique prefixes, unique dirs, no 'fo' prefix, dir exists
  const prefixes = new Set<string>();
  const dirs = new Set<string>();
  for (const pack of config.skillPacks) {
    if (prefixes.has(pack.prefix)) {
      issues.push(`duplicate prefix '${pack.prefix}'`);
    }
    prefixes.add(pack.prefix);

    if (pack.prefix === "fo") {
      issues.push(`prefix 'fo' is reserved for forge`);
    }

    if (dirs.has(pack.dir)) {
      issues.push(`duplicate dir '${pack.dir}'`);
    }
    dirs.add(pack.dir);

    const packDirExists = await pathExists(join(workspaceRoot, pack.dir));
    if (!packDirExists) {
      issues.push(`pack dir '${pack.dir}' does not exist`);
    }
  }

  // Check for stale/missing pack skill copies
  const packSkills = discoverPackSkills(workspaceRoot, config);
  const agentsSkillsDir = join(workspaceRoot, config.paths.skillsDir);

  for (const skill of packSkills) {
    const srcPath = join(workspaceRoot, skill.dir, skill.path);
    const destPath = join(agentsSkillsDir, skill.name, "SKILL.md");

    const srcExists = await pathExists(srcPath);
    const destExists = await pathExists(destPath);

    if (srcExists && destExists) {
      const srcContent = await readFile(srcPath, "utf8").catch(() => "");
      const destContent = await readFile(destPath, "utf8").catch(() => "");
      if (srcContent !== destContent) {
        issues.push(`stale copy of '${skill.name}'`);
      }
    } else if (srcExists && !destExists) {
      issues.push(`missing copy of '${skill.name}'`);
    }
  }

  return {
    name: "pack-skills",
    status: issues.length === 0 ? "pass" : "warn",
    message:
      issues.length === 0
        ? `${packSkills.length} pack skill(s) in sync`
        : `${issues.length} issue(s): ${issues.join(", ")} — run 'forge create' to sync`,
  };
}

export async function runDoctor(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<{ command: string; checks: DoctorCheck[]; allPass: boolean; forbiddenImports: ForbiddenImport[]; bindings: BindingValidation }>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const checks: DoctorCheck[] = [];

  // Check forge.yaml
  const forgeYamlExists = await pathExists(join(workspaceRoot, "forge.yaml"));
  checks.push({
    name: "forge.yaml",
    status: forgeYamlExists ? "pass" : "warn",
    message: forgeYamlExists
      ? "forge.yaml found"
      : "forge.yaml not found — run 'forge create' to create project configuration",
  });

  // Check AGENTS.md
  const agentsMdExists = await pathExists(join(workspaceRoot, "AGENTS.md"));
  checks.push({
    name: "AGENTS.md",
    status: agentsMdExists ? "pass" : "warn",
    message: agentsMdExists
      ? "AGENTS.md found"
      : "AGENTS.md not found — run 'forge create' to deploy agent instructions",
  });

  // Check PREFERENCES.md
  const preferencesExists = await pathExists(join(workspaceRoot, "PREFERENCES.md"));
  checks.push({
    name: "PREFERENCES.md",
    status: preferencesExists ? "pass" : "warn",
    message: preferencesExists
      ? "PREFERENCES.md found"
      : "PREFERENCES.md not found — run 'forge create' to create preferences file",
  });

  // Check .agents/skills/
  const skillsDirExists = await pathExists(join(workspaceRoot, ".agents", "skills"));
  checks.push({
    name: ".agents/skills/",
    status: skillsDirExists ? "pass" : "fail",
    message: skillsDirExists
      ? ".agents/skills/ directory found"
      : ".agents/skills/ directory not found — run 'forge create' to deploy skills",
  });

  // Check docs/rfcs/
  const rfcsDirExists = await pathExists(join(workspaceRoot, "docs", "rfcs"));
  checks.push({
    name: "docs/rfcs/",
    status: rfcsDirExists ? "pass" : "warn",
    message: rfcsDirExists
      ? "docs/rfcs/ directory found"
      : "docs/rfcs/ directory not found — run 'forge create' to create RFC directory",
  });

  // Check docs/adrs/
  const adrsDirExists = await pathExists(join(workspaceRoot, "docs", "adrs"));
  checks.push({
    name: "docs/adrs/",
    status: adrsDirExists ? "pass" : "warn",
    message: adrsDirExists
      ? "docs/adrs/ directory found"
      : "docs/adrs/ directory not found — run 'forge create' to create ADR directory",
  });

  // Check @gogol/* forbidden imports (autonomy guard)
  let forgeRoot: string;
  try {
    forgeRoot = resolveForgeRoot(workspaceRoot);
  } catch {
    forgeRoot = join(workspaceRoot, "packages", "forge");
  }
  const forbiddenImports = await scanForForbiddenImports(forgeRoot, workspaceRoot);
  checks.push({
    name: "autonomy-guard",
    status: forbiddenImports.length === 0 ? "pass" : "fail",
    message:
      forbiddenImports.length === 0
        ? "No @gogol/* imports in forge source"
        : `${forbiddenImports.length} @gogol/* import(s) found in forge source — remove them`,
  });

  // Check bindings contract (RFC-0393)
  const bindingsResult = await validateBindings(workspaceRoot);
  checks.push({
    name: "bindings",
    status: bindingsResult.invalid.length === 0 ? "pass" : "fail",
    message:
      bindingsResult.invalid.length === 0
        ? `Bindings: ${bindingsResult.resolved.length} resolved, ${bindingsResult.absent.length} absent`
        : `Bindings: ${bindingsResult.invalid.length} invalid — ${bindingsResult.invalid.join(", ")}`,
  });

  // Check stale knowledge files (RFC-0524, RFC-0539)
  const staleCheck = await checkStaleKnowledgeFiles(workspaceRoot, forgeRoot);
  checks.push(staleCheck);

  // RFC-0539: Check pack skills — stale/missing copies and config validation
  const packCheck = await checkPackSkills(workspaceRoot);
  checks.push(packCheck);

  const allPass = checks.every((c) => c.status === "pass");
  const hasFails = checks.some((c) => c.status === "fail");

  if (outputFormat === "pretty") {
    logger.section(`Forge Doctor — ${workspaceRoot}`);
    for (const check of checks) {
      const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✖";
      const fn = check.status === "pass" ? logger.success : check.status === "warn" ? logger.warn : logger.error;
      fn(`${icon} ${check.name}: ${check.message}`);
    }
    if (allPass) {
      logger.success("All checks passed — forge is properly configured.");
    } else if (hasFails) {
      logger.error("Some checks failed — run 'forge create' to fix.");
    } else {
      logger.warn("Some checks warn — review above.");
    }
  }

  return {
    data: { command: "forge.doctor", checks, allPass, forbiddenImports, bindings: bindingsResult },
    exitCode: hasFails ? 1 : 0,
    summary: allPass
      ? "forge.doctor: all checks passed"
      : `forge.doctor: ${checks.filter((c) => c.status === "fail").length} fail(s), ${checks.filter((c) => c.status === "warn").length} warn(s)`,
  };
}
