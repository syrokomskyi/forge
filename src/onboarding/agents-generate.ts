/*
<MODULE_CONTRACT>
<purpose>forge.agents.generate — regenerates AGENTS.md deterministically from forge.yaml + skill registry. Carries the standard generated-file marker.</purpose>
<non-goals>
  <item>Do not overwrite a hand-written AGENTS.md (no generated marker) — refuse with exit 1.</item>
  <item>Do not read or modify forge.yaml — only read it via loadForgeConfig.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0391: initial forge.agents.generate handler.</item>
  <item>RFC-0393: added Capabilities section rendered from resolved bindings.</item>
  <item>RFC-0548: added Core behavioral layer section with intent-to-skill routing table from triggers, fixed policy text, and conditional extended layer (RFC-0549) based on register.</item>
  <item>RFC-0549: replaced extended layer stub with full nine-section content from extended-behavioral-layer.ts.</item>
  <item>RFC-0551: added register-conditional commit policy to core behavioral layer.</item>
  <item>RFC-0611: added nested AGENTS.md generation for workspace directories + dryRun support.</item>
  <item>RFC-0640: load workspaceTypes from stack profile and pass to generateNestedAgentsMd for profile-driven workspace detection.</item>
  <item>RFC-0643: terminology substitution on final content, root template selection by register, details field in result.</item>
  <item>RFC-0664: added project memory layer read discipline section to generated AGENTS.md.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadForgeConfig, resolveBinding, resolveForgeRoot } from "../config/forge-config.ts";
import { resolveAllTerminology } from "../profiles/terminology-utils.ts";
import { FORGE_SKILLS } from "../registry.ts";
import { GENERATED_MARKER, buildGeneratedHeader, hasGeneratedMarker, writeFileIfChanged } from "../utils/index.ts";
import { generateNestedAgentsMd } from "./nested-agents-generate.ts";
import { listStackProfiles } from "../profiles/stack-profile.ts";
import type { StackProfile } from "../profiles/stack-profile.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../types.ts";

type BehavioralRegister = "business" | "creative";

// RFC-0643: Template placeholder substitution for {{terminology.key}} patterns
export function substituteTemplate(
  content: string,
  terminology: Record<string, string>,
): string {
  return content.replace(
    /\{\{terminology\.(\w+)\}\}/g,
    (_, key: string) => terminology[key] ?? key,
  );
}

// RFC-0643: Template context for root AGENTS.md generation
export interface TemplateContext {
  terminology: Record<string, string>;
  register: BehavioralRegister;
  domain: string | null;
  workspaceType?: string;
}

// RFC-0643: Root template paths
const BUSINESS_ROOT_TEMPLATE = path.join(import.meta.dirname, "templates", "root-agents-business.md");
const CREATIVE_ROOT_TEMPLATE = path.join(import.meta.dirname, "templates", "root-agents-creative.md");

// Behavioral layer template paths
const BEHAVIORAL_LAYER_CORE_TEMPLATE = path.join(import.meta.dirname, "templates", "behavioral-layer-core.md");
const BEHAVIORAL_LAYER_EXTENDED_TEMPLATE = path.join(import.meta.dirname, "templates", "behavioral-layer-extended.md");

export function selectRootTemplate(register: BehavioralRegister): string {
  try {
    const templatePath = register === "creative" ? CREATIVE_ROOT_TEMPLATE : BUSINESS_ROOT_TEMPLATE;
    return fs.readFileSync(templatePath, "utf8");
  } catch {
    // Template file not found — fall back to empty string (dynamic sections will still be appended)
    return "";
  }
}

function replaceProjectPlaceholders(
  template: string,
  config: ReturnType<typeof loadForgeConfig>,
  dynamicSections: string,
): string {
  let result = template;
  result = result.replace(/\{\{projectName\}\}/g, config.project.name);
  result = result.replace(/\{\{projectStack\}\}/g, config.project.stack.length > 0 ? config.project.stack.join(", ") : "(none)");
  result = result.replace(/\{\{projectPm\}\}/g, config.project.packageManager);
  result = result.replace(/\{\{rfcsDir\}\}/g, config.paths.rfcsDir);
  result = result.replace(/\{\{adrsDir\}\}/g, config.paths.adrsDir);
  result = result.replace(/\{\{plansDir\}\}/g, config.paths.plansDir);
  result = result.replace(/\{\{auditsDir\}\}/g, config.paths.auditsDir);
  result = result.replace(/\{\{specsDir\}\}/g, config.paths.specsDir);
  result = result.replace(/\{\{skillsDir\}\}/g, config.paths.skillsDir);
  result = result.replace(/\{\{dynamicSections\}\}/g, dynamicSections);
  return result;
}

function readRegister(workspaceRoot: string): BehavioralRegister {
  const prefsPath = path.join(workspaceRoot, "PREFERENCES.md");
  try {
    const content = fs.readFileSync(prefsPath, "utf8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      if (fm["register"] === "creative") return "creative";
    }
  } catch {
    // PREFERENCES.md missing or unreadable — default to business
  }
  return "business";
}

function extractTriggers(workspaceRoot: string): Array<{ name: string; triggers: string[] }> {
  const forgeRoot = path.join(workspaceRoot, "packages", "forge");
  const result: Array<{ name: string; triggers: string[] }> = [];
  for (const skill of FORGE_SKILLS) {
    if (skill.category !== "fo") continue;
    const skillPath = path.join(forgeRoot, skill.path);
    try {
      const content = fs.readFileSync(skillPath, "utf8");
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) continue;
      const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      if (Array.isArray(fm["triggers"])) {
        result.push({
          name: skill.name,
          triggers: (fm["triggers"] as unknown[]).filter((v): v is string => typeof v === "string"),
        });
      }
    } catch {
      // SKILL.md not found or unreadable — skip
    }
  }
  return result;
}

function generateTriggersTable(triggers: Array<{ name: string; triggers: string[] }>): string {
  const rows: string[] = [];
  for (const { name, triggers: skillTriggers } of triggers) {
    if (skillTriggers.length === 0) continue;
    const display = skillTriggers.map((t) => `"${t}"`).join(", ");
    rows.push(`| ${display} | \`${name}\` |`);
  }
  return rows.length > 0 ? rows.join("\n") + "\n" : "";
}

function generateBehavioralLayer(
  workspaceRoot: string,
  register: BehavioralRegister,
): string {
  const triggers = extractTriggers(workspaceRoot);

  let template: string;
  try {
    template = fs.readFileSync(BEHAVIORAL_LAYER_CORE_TEMPLATE, "utf8").trimEnd();
  } catch {
    return "";
  }

  const triggersTable = generateTriggersTable(triggers);

  let extendedLayer = "";
  if (register === "creative") {
    try {
      extendedLayer = fs.readFileSync(BEHAVIORAL_LAYER_EXTENDED_TEMPLATE, "utf8").trimEnd() + "\n\n";
    } catch {
      // Extended template missing — skip
    }
  }

  let result = template
    .replace(/\{\{triggersTable\}\}/g, triggersTable)
    .replace(/\{\{register\}\}/g, register)
    .replace(/\{\{extendedLayer\}\}/g, extendedLayer);

  return result;
}

interface AgentsGenerateResult {
  command: string;
  status: "pass" | "fail";
  configPath: string;
  generated: string[];
  skipped: string[];
  errors: string[];
  renderedFiles?: { [relPath: string]: string };
  details?: Array<{ path: string; domain?: string; register?: string; workspaceType?: string }>;
}

export async function runAgentsGenerate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AgentsGenerateResult>> {
  const { workspaceRoot, logger, outputFormat, dryRun } = context;

  let config;
  try {
    config = loadForgeConfig(workspaceRoot);
  } catch (err) {
    const msg = (err as Error).message;
    if (outputFormat === "pretty") {
      logger.error(msg);
    }
    return {
      data: {
        command: "forge.agents.generate",
        status: "fail",
        configPath: "forge.yaml",
        generated: [],
        skipped: [],
        errors: [msg],
      },
      exitCode: 1,
      summary: `forge.agents.generate: failed — ${msg}`,
    };
  }

  const agentsMdPath = path.join(workspaceRoot, "AGENTS.md");

  // Edit guard: refuse to overwrite a hand-written AGENTS.md (skipped in dryRun)
  if (!dryRun && fs.existsSync(agentsMdPath)) {
    const existing = fs.readFileSync(agentsMdPath, "utf8");
    if (!hasGeneratedMarker(existing)) {
      const msg = `AGENTS.md exists without a generated marker — refusing to overwrite a hand-written file. Delete or rename it first, then re-run forge.agents.generate.`;
      if (outputFormat === "pretty") {
        logger.error(msg);
      }
      return {
        data: {
          command: "forge.agents.generate",
          status: "fail",
          configPath: "forge.yaml",
          generated: [],
          skipped: [],
          errors: [msg],
        },
        exitCode: 1,
        summary: `forge.agents.generate: failed — hand-written AGENTS.md`,
      };
    }
  }

  // Generate AGENTS.md content
  const header = buildGeneratedHeader({
    filePath: "AGENTS.md",
    ownerCommand: "forge.agents.generate",
    commandPrefix: "forge",
  });

  // RFC-0643: determine register from PREFERENCES.md or profile
  const register = readRegister(workspaceRoot);

  // Build dynamic sections (skills table, capabilities, behavioral layer)
  const dynamicLines: string[] = [];

  // Skills table
  dynamicLines.push("## Skills");
  dynamicLines.push("");
  dynamicLines.push("| Name | Category | Invocation | Concerns |");
  dynamicLines.push("| --- | --- | --- | --- |");
  for (const skill of FORGE_SKILLS) {
    dynamicLines.push(`| ${skill.name} | ${skill.category} | ${skill.invocation} | ${skill.concerns} |`);
  }
  dynamicLines.push("");

  // Capabilities section (RFC-0393)
  if (config.bindings) {
    dynamicLines.push("## Capabilities");
    dynamicLines.push("");
    dynamicLines.push("Bindings resolved from `forge.yaml`:");
    dynamicLines.push("");
    dynamicLines.push("| Key | Status | Value |");
    dynamicLines.push("| --- | --- | --- |");

    const bindingKeys = [
      "commands.validateRfc",
      "commands.validateAdr",
      "commands.typecheck",
      "commands.test",
      "commands.scopedBuild",
      "commands.specValidate",
      "commands.sessionSave",
      "paths.invariantsFile",
      "paths.reviewsDir",
      "paths.handoffsDir",
      "paths.sessionsDir",
    ];

    for (const key of bindingKeys) {
      const value = resolveBinding(config, key);
      const status = value === null ? "absent" : "resolved";
      const display = value === null ? "—" : typeof value === "string" ? `\`${value}\`` : String(value);
      dynamicLines.push(`| ${key} | ${status} | ${display} |`);
    }

    // compassDocs array
    const compassDocs = resolveBinding(config, "paths.compassDocs");
    if (Array.isArray(compassDocs) && compassDocs.length > 0) {
      dynamicLines.push(`| paths.compassDocs | resolved | ${compassDocs.map((d) => `\`${d}\``).join(", ")} |`);
    } else {
      dynamicLines.push(`| paths.compassDocs | absent | — |`);
    }

    // terminology
    if (config.bindings.terminology && Object.keys(config.bindings.terminology).length > 0) {
      dynamicLines.push("");
      dynamicLines.push("**Terminology:**");
      dynamicLines.push("");
      for (const [term, value] of Object.entries(config.bindings.terminology)) {
        dynamicLines.push(`- ${term}: ${value}`);
      }
    }

    dynamicLines.push("");
  }

  // Behavioral layer section (RFC-0548)
  const behavioralLayer = generateBehavioralLayer(workspaceRoot, register);
  dynamicLines.push(behavioralLayer);
  dynamicLines.push("");

  // RFC-0664: Project memory layer read discipline
  dynamicLines.push("## Project memory layer");
  dynamicLines.push("");
  dynamicLines.push("`.agents/memory/MEMORY.md` is the curated hot store (versioned). `.agents/memory/daily/YYYY-MM-DD.md` are append-only warm logs (git-ignored).");
  dynamicLines.push("");
  dynamicLines.push("**Session-start read discipline (advisory):** At session start, read `MEMORY.md` (always), then `daily/<today>.md` and `daily/<yesterday>.md` (if present). Older daily files are cold — use grep when a task references past context.");
  dynamicLines.push("");

  // RFC-0643: Load root template, replace project placeholders, insert dynamic sections
  const rootTemplate = selectRootTemplate(register);
  const dynamicSections = dynamicLines.join("\n");
  let content = replaceProjectPlaceholders(rootTemplate, config, dynamicSections);

  // Prepend generated header (above template content)
  content = header + "\n\n" + content;

  // RFC-0643: Apply terminology substitution on final assembled content
  const profile = config.profile as StackProfile | undefined;
  const resolvedTerminology = resolveAllTerminology(config, profile);
  content = substituteTemplate(content, resolvedTerminology);

  const generated: string[] = ["AGENTS.md"];
  const skipped: string[] = [];
  const renderedFiles: { [relPath: string]: string } = {};
  const details: Array<{ path: string; domain?: string; register?: string; workspaceType?: string }> = [];
  details.push({
    path: "AGENTS.md",
    domain: profile?.domain,
    register,
  });

  if (dryRun) {
    renderedFiles["AGENTS.md"] = content;
  } else {
    await writeFileIfChanged(agentsMdPath, content);
    if (outputFormat === "pretty") {
      logger.success(`Generated ${path.relative(workspaceRoot, agentsMdPath)}`);
    }
  }

  // Nested AGENTS.md generation (RFC-0611)
  // RFC-0640: load workspaceTypes from stack profile for profile-driven detection
  // RFC-0643: prefer config.profile (loaded by loadForgeConfig), fallback to stack-based lookup
  let workspaceTypes: ProfileWorkspaceType[] | undefined;
  if (profile?.workspaceTypes && profile.workspaceTypes.length > 0) {
    workspaceTypes = profile.workspaceTypes;
  } else {
    try {
      const forgeRoot = resolveForgeRoot(workspaceRoot);
      const profiles = listStackProfiles(forgeRoot);
      for (const stackId of config.project.stack) {
        const stackProfile = profiles.find((p) => p.id === stackId);
        if (stackProfile?.workspaceTypes && stackProfile.workspaceTypes.length > 0) {
          workspaceTypes = stackProfile.workspaceTypes;
          break;
        }
      }
    } catch {
      // forge root not resolvable — fallback to hardcoded detection
    }
  }
  const nestedResult = await generateNestedAgentsMd(workspaceRoot, config, dryRun, workspaceTypes);
  generated.push(...nestedResult.generated);
  skipped.push(...nestedResult.skipped);
  Object.assign(renderedFiles, nestedResult.renderedFiles);

  // RFC-0643: add details for nested files
  for (const rel of nestedResult.generated) {
    details.push({
      path: rel,
      domain: profile?.domain,
      workspaceType: nestedResult.workspaceTypeMap?.[rel],
    });
  }

  if (!dryRun && outputFormat === "pretty") {
    for (const rel of nestedResult.generated) {
      logger.success(`Generated ${rel}`);
    }
    for (const rel of nestedResult.skipped) {
      logger.warn(`Skipped ${rel}`);
    }
  }

  return {
    data: {
      command: "forge.agents.generate",
      status: "pass",
      configPath: "forge.yaml",
      generated,
      skipped,
      errors: [],
      details,
      ...(dryRun ? { renderedFiles } : {}),
    },
    exitCode: 0,
    summary: dryRun
      ? `forge.agents.generate: [dry-run] would generate ${generated.length} file(s), skip ${skipped.length}`
      : `forge.agents.generate: OK — ${generated.length} file(s) generated, ${skipped.length} skipped`,
  };
}
