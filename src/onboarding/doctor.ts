/*
<MODULE_CONTRACT>
<purpose>forge.doctor — diagnoses forge state in an existing project.
Checks for forge.yaml, AGENTS.md, PREFERENCES.md, .agents/skills/, docs/rfcs/,
@warpgogol/* import autonomy guard, and bindings contract (RFC-0393).</purpose>
<non-goals>
  <item>Do not modify files — doctor is read-only diagnostics.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial forge.doctor handler for autonomy refactor.</item>
  <item>RFC-0391: added @warpgogol/* forbidden-imports autonomy guard.</item>
  <item>RFC-0393: added bindings validation — resolved/absent/invalid reporting.</item>
  <item>RFC-0524: added stale knowledge file detection — compares source and .agents/ copies.</item>
  <item>RFC-0539: extended knowledge file check to iterate pack skills via discoverPackSkills. Added pack-skills check for stale/missing copies and skillPacks config validation.</item>
  <item>RFC-0540: added defaultable-binding-null notices for forge-CLI-backed bindings.</item>
  <item>RFC-0611: added nested AGENTS.md checks — missing, stale (dryRun comparison), hand-written improvement.</item>
  <item>RFC-0640: added domain reporting, invariant listing (reported-only), terminology resolution, --strict flag, and software-specific check skipping for non-software domains.</item>
  <item>RFC-0660: added legacy-section count reporting for structured knowledge files.</item>
  <item>RFC-0661: added knowledge-budgets check — validates override shape, computes per-skill budget reports, reports summary with headroom %.</item>
</CHANGE_SUMMARY>
*/

import { readFile, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../types.ts";
import { resolveForgeRoot, loadForgeConfig, resolveBinding, resolveTerminology, FORGE_CLI_BINDING_DEFAULTS, resolvePmRunner } from "../config/forge-config.ts";
import { FORGE_SKILLS, discoverPackSkills } from "../registry.ts";
import { discoverWorkspaces } from "./workspace-discovery.ts";
import { buildNestedAgentsMd } from "./nested-agents-templates.ts";
import { listStackProfiles } from "../profiles/stack-profile.ts";
import { TERMINOLOGY_DEFAULTS } from "../profiles/profile-schema.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";
import { runProfileValidate } from "./profile-validate.ts";
import { parseKnowledgeFile } from "../knowledge/index.ts";
import type { ParsedKnowledgeFile } from "../knowledge/index.ts";
import { computeLayerBudgets, resolveKnowledgeBudgets, DEFAULT_KNOWLEDGE_BUDGETS } from "../knowledge/budgets.ts";

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
  /(?:^|\n)\s*(?:import\s+[^;]+?\s+from\s+|require\s*\(\s*)["'`](@warpgogol\/[^"'`]+)["'`]/g;

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
  "commands.sessionSave",
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
// Legacy section detection (RFC-0660)
// ---------------------------------------------------------------------------

function checkLegacyKnowledgeSections(
  workspaceRoot: string,
  forgeRoot: string,
): DoctorCheck {
  let config;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch {
    return { name: "knowledge-legacy", status: "pass", message: "No forge.yaml — legacy section check skipped" };
  }

  let totalLegacy = 0;
  let filesWithLegacy = 0;

  // Check forge skills
  for (const skill of FORGE_SKILLS) {
    if (!skill.knowledge || skill.knowledge.length === 0) continue;
    const skillDir = join(forgeRoot, dirname(skill.path));
    for (const kf of skill.knowledge) {
      const kfPath = join(skillDir, kf);
      try {
        const parsed = parseKnowledgeFile(kfPath);
        if (parsed.isKnowledgeAdjacent) continue;
        if (parsed.legacySections.length > 0) {
          totalLegacy += parsed.legacySections.length;
          filesWithLegacy++;
        }
      } catch {
        // File read errors are handled by stale knowledge check
      }
    }
  }

  // Check pack skills
  const packSkills = discoverPackSkills(workspaceRoot, config);
  for (const skill of packSkills) {
    if (!skill.knowledge || skill.knowledge.length === 0) continue;
    const skillDir = join(workspaceRoot, skill.dir, dirname(skill.path));
    for (const kf of skill.knowledge) {
      const kfPath = join(skillDir, kf);
      try {
        const parsed = parseKnowledgeFile(kfPath);
        if (parsed.isKnowledgeAdjacent) continue;
        if (parsed.legacySections.length > 0) {
          totalLegacy += parsed.legacySections.length;
          filesWithLegacy++;
        }
      } catch {
        // File read errors are handled by stale knowledge check
      }
    }
  }

  return {
    name: "knowledge-legacy",
    status: totalLegacy === 0 ? "pass" : "warn",
    message:
      totalLegacy === 0
        ? "No legacy knowledge sections"
        : `${totalLegacy} legacy section${totalLegacy === 1 ? "" : "s"} across ${filesWithLegacy} knowledge file${filesWithLegacy === 1 ? "" : "s"} — run the knowledge compaction command to migrate`,
  };
}

// ---------------------------------------------------------------------------
// Knowledge budget check (RFC-0661)
// ---------------------------------------------------------------------------

function checkKnowledgeBudgets(
  workspaceRoot: string,
  forgeRoot: string,
): DoctorCheck {
  let config;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch {
    return { name: "knowledge-budgets", status: "pass", message: "No forge.yaml — budget check skipped" };
  }

  // Validate override shape if present
  const overrideWarnings: string[] = [];
  const effectiveBudgets = resolveKnowledgeBudgets(workspaceRoot);
  let usingDefaults = true;

  try {
    const forgeYamlPath = join(workspaceRoot, "forge.yaml");
    const content = readFileSync(forgeYamlPath, "utf8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const bindings = parsed?.bindings as Record<string, unknown> | undefined;
    const knowledge = bindings?.knowledge as Record<string, unknown> | undefined;
    const budgets = knowledge?.budgets as { hot?: unknown; warm?: unknown } | undefined;

    if (budgets) {
      usingDefaults = false;
      if (typeof budgets.hot !== "number" || budgets.hot <= 0 || !Number.isInteger(budgets.hot)) {
        overrideWarnings.push(`bindings.knowledge.budgets.hot invalid (got ${String(budgets.hot)}), using default ${DEFAULT_KNOWLEDGE_BUDGETS.hot}`);
      }
      if (typeof budgets.warm !== "number" || budgets.warm <= 0 || !Number.isInteger(budgets.warm)) {
        overrideWarnings.push(`bindings.knowledge.budgets.warm invalid (got ${String(budgets.warm)}), using default ${DEFAULT_KNOWLEDGE_BUDGETS.warm}`);
      }
    }
  } catch {
    // forge.yaml not readable — defaults already applied
  }

  // Collect all parsed knowledge files from forge skills and pack skills
  const parsedFiles: { file: ParsedKnowledgeFile; skillName: string; pack?: string }[] = [];

  for (const skill of FORGE_SKILLS) {
    if (!skill.knowledge || skill.knowledge.length === 0) continue;
    const skillDir = join(forgeRoot, dirname(skill.path));
    for (const kf of skill.knowledge) {
      const kfPath = join(skillDir, kf);
      try {
        const parsed = parseKnowledgeFile(kfPath);
        if (parsed.layer !== null && parsed.layer !== "L0" && !parsed.isKnowledgeAdjacent && parsed.parseIssues.length === 0) {
          parsedFiles.push({ file: parsed, skillName: skill.name });
        }
      } catch {
        // File read errors are handled by stale knowledge check
      }
    }
  }

  const packSkills = discoverPackSkills(workspaceRoot, config);
  for (const skill of packSkills) {
    if (!skill.knowledge || skill.knowledge.length === 0) continue;
    const skillDir = join(workspaceRoot, skill.dir, dirname(skill.path));
    for (const kf of skill.knowledge) {
      const kfPath = join(skillDir, kf);
      try {
        const parsed = parseKnowledgeFile(kfPath);
        if (parsed.layer !== null && parsed.layer !== "L0" && !parsed.isKnowledgeAdjacent && parsed.parseIssues.length === 0) {
          parsedFiles.push({ file: parsed, skillName: skill.name, pack: skill.pack });
        }
      } catch {
        // File read errors are handled by stale knowledge check
      }
    }
  }

  // Compute budget reports
  const filesForBudget = parsedFiles.map((p) => p.file);
  const skillNames = new Map<string, string>();
  for (const p of parsedFiles) {
    skillNames.set(p.file.path, p.skillName);
  }

  const reports = computeLayerBudgets(filesForBudget, effectiveBudgets, skillNames);

  // Build summary
  const budgetSource = usingDefaults ? "defaults" : "override";
  const parts: string[] = [`budgets: hot=${effectiveBudgets.hot} warm=${effectiveBudgets.warm} (${budgetSource})`];

  if (reports.length > 0) {
    const summary = reports.map((r) => {
      const pct = Math.round((r.activeChars / r.budget) * 100);
      return `${r.skill}/${r.file}[${r.layer}]: ${r.activeChars}/${r.budget} (${pct}%)`;
    });
    parts.push(`${reports.length} file${reports.length === 1 ? "" : "s"}: ${summary.join(", ")}`);
  } else {
    parts.push("no hot/warm knowledge files to check");
  }

  if (overrideWarnings.length > 0) {
    parts.push(overrideWarnings.join("; "));
  }

  const status: DoctorCheck["status"] = overrideWarnings.length > 0 ? "warn" : "pass";

  return {
    name: "knowledge-budgets",
    status,
    message: parts.join(" | "),
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

// ---------------------------------------------------------------------------
// Nested AGENTS.md diagnostics (RFC-0611)
// ---------------------------------------------------------------------------

async function checkNestedAgentsMd(
  workspaceRoot: string,
  workspaceTypes?: ProfileWorkspaceType[],
): Promise<DoctorCheck> {
  let config;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch {
    return {
      name: "nested-AGENTS.md",
      status: "pass",
      message: "forge.yaml not loadable — nested AGENTS.md check skipped",
    };
  }

  const workspaces = discoverWorkspaces(workspaceRoot, workspaceTypes);

  if (workspaces.length === 0) {
    return {
      name: "nested-AGENTS.md",
      status: "pass",
      message: "no workspace directories found",
    };
  }

  const issues: string[] = [];
  let missing = 0;
  let stale = 0;
  let handwritten = 0;

  for (const ws of workspaces) {
    if (!ws.hasAgentsMd) {
      missing++;
      issues.push(`${ws.path}/AGENTS.md missing`);
      continue;
    }

    if (!ws.isGenerated) {
      handwritten++;
      const suggestions: string[] = [];
      try {
        const content = await readFile(join(workspaceRoot, ws.path, "AGENTS.md"), "utf8");
        if (!content.includes("AGENTS.md")) {
          suggestions.push("reference root AGENTS.md");
        }
      } catch {
        // unreadable — skip
      }
      if (suggestions.length > 0) {
        issues.push(`${ws.path}/AGENTS.md hand-written — consider: ${suggestions.join(", ")}`);
      }
      continue;
    }

    // Stale check: compare in-memory render to committed file
    try {
      const expected = buildNestedAgentsMd(ws, config);
      const actual = await readFile(join(workspaceRoot, ws.path, "AGENTS.md"), "utf8");
      if (expected !== actual) {
        stale++;
        issues.push(`${ws.path}/AGENTS.md stale — run 'forge agents generate'`);
      }
    } catch {
      // unreadable — skip
    }
  }

  if (issues.length === 0) {
    return {
      name: "nested-AGENTS.md",
      status: "pass",
      message: `${workspaces.length} workspace(s) — all AGENTS.md in sync`,
    };
  }

  const parts: string[] = [];
  if (missing > 0) parts.push(`${missing} missing`);
  if (stale > 0) parts.push(`${stale} stale`);
  if (handwritten > 0) parts.push(`${handwritten} hand-written`);

  return {
    name: "nested-AGENTS.md",
    status: stale > 0 ? "warn" : "pass",
    message: `${parts.join(", ")} — ${issues.slice(0, 3).join("; ")}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Domain reporting (RFC-0640)
// ---------------------------------------------------------------------------

interface DomainReport {
  domain: string;
  register: "business" | "creative" | null;
  terminology: Record<string, string>;
  invariants: Array<{ id: string; rule: string; severity: string }>;
  source: "forge.yaml" | "profile" | "default";
}

function buildTerminologyMap(
  config: ReturnType<typeof loadForgeConfig>,
  profileTerminology?: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(TERMINOLOGY_DEFAULTS)) {
    result[key] = resolveTerminology(config, profileTerminology, key);
  }
  // Also include any custom keys from bindings.terminology
  if (config.bindings?.terminology) {
    for (const key of Object.keys(config.bindings.terminology)) {
      if (!(key in result)) {
        result[key] = resolveTerminology(config, profileTerminology, key);
      }
    }
  }
  return result;
}

function resolveDomainReport(workspaceRoot: string, forgeRoot: string): DomainReport {
  // 1. Try forge.yaml domain field
  try {
    const config = loadForgeConfig(workspaceRoot);
    if (config.project.domain) {
      const terminology = buildTerminologyMap(config);
      const register = readRegisterFromPrefs(workspaceRoot);
      return {
        domain: config.project.domain,
        register,
        terminology,
        invariants: [],
        source: "forge.yaml",
      };
    }
  } catch {
    // forge.yaml not loadable
  }

  // 2. Try to find domain from stack profile matching config.project.stack
  try {
    const config = loadForgeConfig(workspaceRoot);
    const profiles = listStackProfiles(forgeRoot);
    for (const stackId of config.project.stack) {
      const profile = profiles.find((p) => p.id === stackId);
      if (profile?.domain) {
        const terminology = buildTerminologyMap(config, profile.terminology);
        const register = profile.register ?? readRegisterFromPrefs(workspaceRoot);
        return {
          domain: profile.domain,
          register,
          terminology,
          invariants: profile.invariants ?? [],
          source: "profile",
        };
      }
    }
  } catch {
    // config or profiles not loadable
  }

  // 3. Default: software domain
  return {
    domain: "software",
    register: null,
    terminology: {},
    invariants: [],
    source: "default",
  };
}

function readRegisterFromPrefs(workspaceRoot: string): "business" | "creative" | null {
  try {
    const prefsPath = join(workspaceRoot, "PREFERENCES.md");
    const content = readFileSync(prefsPath, "utf8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      if (fm["register"] === "creative") return "creative";
      if (fm["register"] === "business") return "business";
    }
  } catch {
    // PREFERENCES.md missing or unreadable
  }
  return null;
}

function checkDomainInfo(domainReport: DomainReport): DoctorCheck {
  const parts: string[] = [`domain: ${domainReport.domain}`, `source: ${domainReport.source}`];
  if (domainReport.register) {
    parts.push(`register: ${domainReport.register}`);
  }
  if (Object.keys(domainReport.terminology).length > 0) {
    const terms = Object.entries(domainReport.terminology)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    parts.push(`terminology: ${terms}`);
  }
  if (domainReport.invariants.length > 0) {
    parts.push(`invariants: ${domainReport.invariants.length} declared`);
  }

  return {
    name: "domain-info",
    status: "pass",
    message: parts.join(", "),
  };
}

export async function runDoctor(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<{ command: string; checks: DoctorCheck[]; allPass: boolean; forbiddenImports: ForbiddenImport[]; bindings: BindingValidation; domain?: DomainReport }>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const strict = input.flags["strict"] === true;
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

  // Check @warpgogol/* forbidden imports (autonomy guard)
  let forgeRoot: string;
  try {
    forgeRoot = resolveForgeRoot(workspaceRoot);
  } catch {
    forgeRoot = join(workspaceRoot, "packages", "forge");
  }

  // RFC-0640: Resolve domain report for domain-aware checks
  const domainReport = resolveDomainReport(workspaceRoot, forgeRoot);

  // RFC-0640: Domain info check
  checks.push(checkDomainInfo(domainReport));

  // RFC-0640: List invariants (reported-only, not automatically checked)
  if (domainReport.invariants.length > 0) {
    const invariantMessages = domainReport.invariants.map((inv) => `${inv.id}: ${inv.rule}`);
    checks.push({
      name: "domain-invariants",
      status: "pass",
      message: `${domainReport.invariants.length} invariant(s) declared (advisory): ${invariantMessages.slice(0, 3).join("; ")}${invariantMessages.length > 3 ? ` (+${invariantMessages.length - 3} more)` : ""}`,
    });
  }

  // RFC-0640: Run forge.profile.validate as advisory check (warn on failure, not fail)
  const profileValidateResult = await runProfileValidate(
    { argv: [], flags: {} },
    { ...context, forgeRoot },
  );
  const invalidProfiles = profileValidateResult.data?.profiles.filter((p) => !p.valid) ?? [];
  checks.push({
    name: "profile-validate",
    status: invalidProfiles.length === 0 ? "pass" : "warn",
    message:
      invalidProfiles.length === 0
        ? `${profileValidateResult.data?.profiles.length ?? 0} profile(s) valid`
        : `${invalidProfiles.length} profile(s) invalid (advisory): ${invalidProfiles.map((p) => p.id).join(", ")}`,
  });

  const forbiddenImports = await scanForForbiddenImports(forgeRoot, workspaceRoot);
  checks.push({
    name: "autonomy-guard",
    status: forbiddenImports.length === 0 ? "pass" : "fail",
    message:
      forbiddenImports.length === 0
        ? "No @warpgogol/* imports in forge source"
        : `${forbiddenImports.length} @warpgogol/* import(s) found in forge source — remove them`,
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

  // RFC-0660: Check legacy sections in knowledge files
  const legacyCheck = checkLegacyKnowledgeSections(workspaceRoot, forgeRoot);
  checks.push(legacyCheck);

  // RFC-0661: Check knowledge layer token budgets
  const budgetCheck = checkKnowledgeBudgets(workspaceRoot, forgeRoot);
  checks.push(budgetCheck);

  // RFC-0539: Check pack skills — stale/missing copies and config validation
  const packCheck = await checkPackSkills(workspaceRoot);
  checks.push(packCheck);

  // RFC-0611: Check nested AGENTS.md — missing, stale, hand-written
  // RFC-0640: Use profile-driven workspace types when available (all domains)
  // RFC-0640 fix: previously gated by isSoftwareDomain, which skipped the check
  // entirely for non-software domains. Now runs for all domains — profile-driven
  // wsTypes replace hardcoded detection when present.
  {
    let wsTypes: ProfileWorkspaceType[] | undefined;
    try {
      const config = loadForgeConfig(workspaceRoot);
      // RFC-0643: prefer config.profile (loaded by loadForgeConfig)
      if (config.profile?.workspaceTypes && config.profile.workspaceTypes.length > 0) {
        wsTypes = config.profile.workspaceTypes;
      } else {
        const profiles = listStackProfiles(forgeRoot);
        for (const stackId of config.project.stack) {
          const profile = profiles.find((p) => p.id === stackId);
          if (profile?.workspaceTypes && profile.workspaceTypes.length > 0) {
            wsTypes = profile.workspaceTypes;
            break;
          }
        }
      }
    } catch {
      // profiles not loadable
    }
    const nestedCheck = await checkNestedAgentsMd(workspaceRoot, wsTypes);
    checks.push(nestedCheck);
  }

  // RFC-0640: --strict flag elevates warn to fail for domain-related checks
  const finalChecks = strict
    ? checks.map((c) =>
        c.status === "warn" &&
        (c.name === "domain-invariants" || c.name === "profile-validate")
          ? { ...c, status: "fail" as const }
          : c,
      )
    : checks;

  const allPass = finalChecks.every((c) => c.status === "pass");
  const hasFails = finalChecks.some((c) => c.status === "fail");

  if (outputFormat === "pretty") {
    logger.section(`Forge Doctor — ${workspaceRoot}`);
    for (const check of finalChecks) {
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
    data: { command: "forge.doctor", checks: finalChecks, allPass, forbiddenImports, bindings: bindingsResult, domain: domainReport },
    exitCode: hasFails ? 1 : 0,
    summary: allPass
      ? "forge.doctor: all checks passed"
      : `forge.doctor: ${finalChecks.filter((c) => c.status === "fail").length} fail(s), ${finalChecks.filter((c) => c.status === "warn").length} warn(s)`,
  };
}
