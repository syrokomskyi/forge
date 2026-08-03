/*
<MODULE_CONTRACT>
<purpose>forge.init — deploys forge into a project: creates forge.yaml, PREFERENCES.md, copies skills to .agents/skills/, creates docs directories, copies RFC template. Config-driven via resolveForgeRoot and loadForgeConfig.</purpose>
<non-goals>
  <item>Do not overwrite existing forge.yaml, PREFERENCES.md, or kernel.config.ts — skip with warning.</item>
  <item>Do not generate AGENTS.md — that is forge.agents.generate's responsibility.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forge.init handler.</item>
  <item>RFC-0391: reworked to be config-driven — creates forge.yaml, uses resolveForgeRoot, creates docs/plans/ and docs/audits/ directories.</item>
  <item>RFC-0392: added --from flag for stack detection from existing project or spec folder.</item>
  <item>RFC-0393: defaultForgeConfig now includes default bindings section (all commands null, default paths).</item>
  <item>RFC-0524: extended skill sync to copy declared knowledge files alongside SKILL.md.</item>
  <item>RFC-0539: extended skill sync to also copy declared pack skills from skillPacks config.</item>
  <item>RFC-0543: write forge.syncedVersion on first init (set to installed forge version).</item>
  <item>RFC-0544: accept optional context.forgeRoot to support composition from forge.create.</item>
  <item>RFC-0544 fix: export InitResult interface for type-safe consumption by forge.create.</item>
  <item>RFC-0552: add skippedSkills to InitResult, detect Forge-vs-pack skill name conflicts.</item>
  <item>RFC-0640: accept optional domain fields from profile (register, domain, terminology, semanticBindings) and write them into PREFERENCES.md and forge.yaml.</item>
  <item>RFC-0643: accept optional profileId and write it to forge.yaml as the `profile` field.</item>
  <item>RFC-0663: added syncSharedKnowledge step to sync shared knowledge layer to .agents/skills/shared-knowledge/.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { FORGE_SKILLS, discoverPackSkills } from "../registry.ts";
import { defaultForgeConfig, loadForgeConfig, resolveForgeRoot, type ForgeConfig } from "../config/forge-config.ts";
import { listStackProfiles, detectStack } from "../profiles/stack-profile.ts";

export interface SkippedSkill {
  name: string;
  reason: string;
}

export interface InitResult {
  command: string;
  status: "pass" | "fail";
  configPath?: string;
  created: string[];
  skipped: string[];
  errors: string[];
  skippedSkills: SkippedSkill[];
  detection?: { profile: string | null; unsupported: string[] };
}

export interface InitDomainFields {
  register?: "business" | "creative";
  domain?: string;
  terminology?: Record<string, string>;
  semanticBindings?: Record<string, string | null>;
  profileId?: string;
}

export function runInit(
  input: { flags: { aiLanguage?: string; documentationLanguage?: string; from?: string } },
  context: unknown,
  domainFields?: InitDomainFields,
): InitResult {
  const ctx = context as { workspaceRoot?: string; forgeRoot?: string };
  const workspaceRoot = ctx?.workspaceRoot ?? process.cwd();
  const contextForgeRoot = ctx?.forgeRoot;

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  const skippedSkills: SkippedSkill[] = [];

  const aiLang = input.flags?.aiLanguage ?? "en";
  const docLang = input.flags?.documentationLanguage ?? "en";

  // 0. Handle --from flag: detect stack from existing project
  let detection: { profile: string | null; unsupported: string[] } | undefined;
  const fromPath = input.flags?.from;
  if (fromPath) {
    const resolvedFrom = path.resolve(fromPath);
    if (!fs.existsSync(resolvedFrom)) {
      return {
        command: "forge.init",
        status: "fail",
        created,
        skipped,
        errors: [`--from path does not exist: ${resolvedFrom}`],
        skippedSkills,
      };
    }
    let forgeRootForProfiles: string;
    if (contextForgeRoot) {
      forgeRootForProfiles = contextForgeRoot;
    } else {
      try {
        forgeRootForProfiles = resolveForgeRoot(workspaceRoot);
      } catch {
        forgeRootForProfiles = workspaceRoot;
      }
    }
    const profiles = listStackProfiles(forgeRootForProfiles);
    const match = detectStack(resolvedFrom, profiles);
    detection = {
      profile: match?.id ?? null,
      unsupported: match ? [] : ["unknown"],
    };
  }

  // 0b. Create forge.yaml if missing
  const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
  let config: ForgeConfig;
  if (fs.existsSync(forgeYamlPath)) {
    skipped.push("forge.yaml (already exists)");
    try {
      config = loadForgeConfig(workspaceRoot);
    } catch {
      config = defaultForgeConfig(path.basename(workspaceRoot));
    }
  } else {
    const projectName = path.basename(workspaceRoot);
    config = defaultForgeConfig(projectName);
    // If detection found a stack, write it into config
    if (detection?.profile) {
      config.project.stack = [detection.profile];
    }
    // RFC-0543: set forge.syncedVersion to the installed forge version
    try {
      const forgeRootForVersion = contextForgeRoot ?? resolveForgeRoot(workspaceRoot);
      const pkgPath = path.join(forgeRootForVersion, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
      if (pkg.version) {
        config.forge = { syncedVersion: pkg.version };
      }
    } catch {
      // forge root not resolvable — leave syncedVersion as null (default)
    }
    // RFC-0643: write profile id to forge.yaml
    if (domainFields?.profileId) {
      (config as unknown as Record<string, unknown>).profile = domainFields.profileId;
    }
    // RFC-0640: write domain fields from profile into forge.yaml
    if (domainFields?.domain) {
      config.project.domain = domainFields.domain;
    }
    if (domainFields?.terminology && config.bindings) {
      config.bindings.terminology = { ...config.bindings.terminology, ...domainFields.terminology };
    }
    if (domainFields?.semanticBindings && config.bindings) {
      for (const [key, value] of Object.entries(domainFields.semanticBindings)) {
        if (key in config.bindings.commands) {
          (config.bindings.commands as Record<string, string | null>)[key] = value;
        }
      }
    }
    const yamlContent = stringifyYaml(config);
    fs.writeFileSync(forgeYamlPath, yamlContent, "utf8");
    created.push("forge.yaml");
  }

  // 1. Resolve forge root (monorepo or npm-installed, or from context)
  let forgeRoot: string;
  if (contextForgeRoot) {
    forgeRoot = contextForgeRoot;
  } else {
    try {
      forgeRoot = resolveForgeRoot(workspaceRoot);
    } catch (err) {
      return {
        command: "forge.init",
        status: "fail",
        configPath: "forge.yaml",
        created,
        skipped,
        errors: [(err as Error).message],
        skippedSkills,
      };
    }
  }

  // 2. Create PREFERENCES.md if missing
  const prefsPath = path.join(workspaceRoot, "PREFERENCES.md");
  const register = domainFields?.register ?? "business";
  if (fs.existsSync(prefsPath)) {
    skipped.push("PREFERENCES.md (already exists)");
  } else {
    const prefsContent = `---\naiLanguage: ${aiLang}\ndocumentationLanguage: ${docLang}\nregister: ${register}\n---\n\n# Operator Preferences\n\n- \`aiLanguage\`: ${aiLang} — AI uses this language for all communication with the operator.\n- \`documentationLanguage\`: ${docLang} — generated documentation uses this language.\n- \`register\`: ${register} — communication register (business or creative).\n`;
    fs.writeFileSync(prefsPath, prefsContent, "utf8");
    created.push("PREFERENCES.md");
  }

  // 3. Copy forge skills to .agents/skills/<name>/ for IDE discovery
  const agentsSkillsDir = path.join(workspaceRoot, config.paths.skillsDir);
  for (const skill of FORGE_SKILLS) {
    const srcPath = path.join(forgeRoot, skill.path);
    const skillName = skill.name;
    const destDir = path.join(agentsSkillsDir, skillName);
    const destPath = path.join(destDir, "SKILL.md");

    if (!fs.existsSync(srcPath)) {
      errors.push(`Source skill not found: ${skill.path}`);
      continue;
    }

    fs.mkdirSync(destDir, { recursive: true });
    const content = fs.readFileSync(srcPath, "utf8");
    fs.writeFileSync(destPath, content, "utf8");
    created.push(`${config.paths.skillsDir}/${skillName}/SKILL.md`);

    // RFC-0524: sync declared knowledge files
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
              const kfContent = fs.readFileSync(kfSrcPath, "utf8");
              fs.writeFileSync(kfDestPath, kfContent, "utf8");
              created.push(`${config.paths.skillsDir}/${skillName}/${kf}`);
            } else {
              errors.push(`Knowledge file '${kf}' declared in ${skillName} but not found in source`);
            }
          }
        }
      } catch {
        // Frontmatter parse error — SKILL-01 will catch this in validation
      }
    }
  }

  // RFC-0539: Copy declared pack skills to .agents/skills/<name>/ for IDE discovery
  // RFC-0552: Detect Forge-vs-pack skill name conflicts, skip pack skills that conflict
  const forgeSkillNames = new Set(FORGE_SKILLS.map((s) => s.name));
  const packSkills = discoverPackSkills(workspaceRoot, config);
  for (const skill of packSkills) {
    const srcPath = path.join(workspaceRoot, skill.dir, skill.path);
    const skillName = skill.name;
    const destDir = path.join(agentsSkillsDir, skillName);
    const destPath = path.join(destDir, "SKILL.md");

    if (!fs.existsSync(srcPath)) {
      errors.push(`Pack skill source not found: ${skill.dir}/${skill.path}`);
      continue;
    }

    if (forgeSkillNames.has(skillName)) {
      skippedSkills.push({ name: skillName, reason: "conflict with Forge skill" });
      continue;
    }

    fs.mkdirSync(destDir, { recursive: true });
    const content = fs.readFileSync(srcPath, "utf8");
    fs.writeFileSync(destPath, content, "utf8");
    created.push(`${config.paths.skillsDir}/${skillName}/SKILL.md`);

    // RFC-0524: sync declared knowledge files for pack skills
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
              const kfContent = fs.readFileSync(kfSrcPath, "utf8");
              fs.writeFileSync(kfDestPath, kfContent, "utf8");
              created.push(`${config.paths.skillsDir}/${skillName}/${kf}`);
            } else {
              errors.push(`Knowledge file '${kf}' declared in ${skillName} but not found in source`);
            }
          }
        }
      } catch {
        // Frontmatter parse error — SKILL-01 will catch this in validation
      }
    }
  }

  // RFC-0663: Sync shared knowledge layer to .agents/skills/shared-knowledge/
  const sharedKnowledgeSrc = path.join(forgeRoot, "skills", "shared", "knowledge", "learned-principles.md");
  if (fs.existsSync(sharedKnowledgeSrc)) {
    const sharedKnowledgeDestDir = path.join(agentsSkillsDir, "shared-knowledge");
    fs.mkdirSync(sharedKnowledgeDestDir, { recursive: true });
    const sharedKnowledgeDest = path.join(sharedKnowledgeDestDir, "learned-principles.md");
    fs.writeFileSync(sharedKnowledgeDest, fs.readFileSync(sharedKnowledgeSrc, "utf8"), "utf8");
    created.push(`${config.paths.skillsDir}/shared-knowledge/learned-principles.md`);
  }

  // 4. Create docs directories from config paths
  const dirsToCreate = [
    { rel: config.paths.rfcsDir, label: "docs/rfcs/" },
    { rel: config.paths.adrsDir, label: "docs/adrs/" },
    { rel: config.paths.plansDir, label: "docs/plans/" },
    { rel: config.paths.auditsDir, label: "docs/audits/" },
  ];
  for (const { rel, label } of dirsToCreate) {
    const dir = path.join(workspaceRoot, rel);
    if (fs.existsSync(dir)) {
      skipped.push(`${label} (already exists)`);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      created.push(`${label}`);
    }
  }

  return {
    command: "forge.init",
    status: errors.length === 0 ? "pass" : "fail",
    configPath: "forge.yaml",
    created,
    skipped,
    errors,
    skippedSkills,
    detection,
  };
}
