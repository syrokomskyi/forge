/*
<MODULE_CONTRACT>
<purpose>Skill registry — machine-readable array of all forge skills, used by forge.skill.validate and forge.create. Also provides discoverPackSkills helper for project-declared skill packs (RFC-0539).</purpose>
<non-goals>
  <item>Do not include third-party skills — only forge-managed skills belong here.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1481: add WorkspaceIO-backed pack skill discovery for mutating knowledge commands.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
  <item>RFC-1435: sync paired skill copies after commit-time CHANGE_SUMMARY injection</item>
  <item>RFC-1481: collapse compass summaries and add missing contract blocks</item>
  <history>RFC-0374, RFC-0395, RFC-0523, RFC-0524, RFC-0538, RFC-0539, RFC-0941</history>
</CHANGE_SUMMARY>
*/

import * as fs from "./utils/sync-fs.ts";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ForgeConfig } from "./config/forge-config.ts";
import type { WorkspaceIO } from "./types.ts";
import { forgePluginManifestSchema } from "./plugin/forge-plugin-manifest.ts";

/**
 * Every entry MUST be portable — it runs in any forge-bootstrapped project
 * using only forge commands, forge bindings, and standard project files.
 * Ecosystem-bound skills belong in project skill packs (RFC-0539), not here.
 */
export interface ForgeSkillEntry {
  name: string;
  category: "fo" | "shared" | "meta";
  invocation: "user" | "model";
  concerns: "read-only" | "document-only" | "content-mutation" | "code-mutation";
  dependsOn: string[];
  path: string;
  knowledge?: string[];
  triggerPhrases?: string[];
}

/**
 * A skill discovered in a project-declared skill pack (RFC-0539).
 * Unlike ForgeSkillEntry, pack skills are discovered at runtime by scanning
 * the pack directory rather than being statically registered.
 */
export interface PackSkillEntry {
  name: string;
  pack: string;
  dir: string;
  path: string;
  knowledge?: string[];
}

/**
 * Discover skills in project-declared skill packs by scanning each pack's
 * directory for `<prefix>-<name>/SKILL.md` entries (RFC-0539).
 *
 * This is the single source of truth for pack skill discovery — used by
 * forge.create, forge.skill.validate, forge.doctor, and forge.skill.list.
 */
export function discoverPackSkills(workspaceRoot: string, config: ForgeConfig): PackSkillEntry[] {
  const result: PackSkillEntry[] = [];
  if (!config.skillPacks) return result;

  for (const pack of config.skillPacks) {
    const packDir = path.resolve(workspaceRoot, pack.dir);
    if (!fs.existsSync(packDir)) continue;

    const manifestPath = path.join(packDir, "forge.plugin.yaml");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `forge.plugin.yaml not found at ${packDir} for pack prefix "${pack.prefix}". ` +
          "Run `forge init` to create manifests for declared skill packs (RFC-0941).",
      );
    }

    let manifestRaw: string;
    try {
      manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    } catch (err) {
      throw new Error(
        `Failed to read forge.plugin.yaml at ${manifestPath}: ${(err as Error).message}`,
      );
    }

    let manifestParsed: unknown;
    try {
      manifestParsed = parseYaml(manifestRaw);
    } catch (err) {
      throw new Error(
        `forge.plugin.yaml at ${manifestPath} is not valid YAML: ${(err as Error).message}`,
      );
    }

    const manifestResult = forgePluginManifestSchema.safeParse(manifestParsed);
    if (!manifestResult.success) {
      const issues = manifestResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`forge.plugin.yaml at ${manifestPath} failed schema validation: ${issues}`);
    }

    const entries = fs.readdirSync(packDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(`${pack.prefix}-`)) continue;

      const skillMdPath = path.join(packDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const relPath = path.relative(packDir, skillMdPath).replace(/\\/g, "/");
      const skillEntry: PackSkillEntry = {
        name: entry.name,
        pack: pack.prefix,
        dir: pack.dir,
        path: relPath,
      };

      // Extract knowledge files from frontmatter if present
      const content = fs.readFileSync(skillMdPath, "utf8");
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        try {
          const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
          if (Array.isArray(fm["knowledge"])) {
            skillEntry.knowledge = (fm["knowledge"] as unknown[]).filter(
              (v): v is string => typeof v === "string",
            );
          }
        } catch {
          // Frontmatter parse error — SKILL-01 will catch this in validation
        }
      }

      result.push(skillEntry);
    }
  }

  return result;
}

/**
 * WorkspaceIO-backed pack discovery for kernel commands that must not use
 * ambient filesystem access (DNA-105).
 */
export async function discoverPackSkillsWithIO(
  workspaceRoot: string,
  config: ForgeConfig,
  io: WorkspaceIO,
): Promise<PackSkillEntry[]> {
  const result: PackSkillEntry[] = [];
  for (const pack of config.skillPacks ?? []) {
    const packDir = path.resolve(workspaceRoot, pack.dir);
    const relativePackDir = path.relative(path.resolve(workspaceRoot), packDir);
    if (
      relativePackDir === ".." ||
      relativePackDir.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePackDir)
    ) {
      throw new Error(`Declared skill pack directory escapes the workspace: ${pack.dir}`);
    }
    if (!(await io.exists(packDir))) continue;
    const manifestPath = path.join(packDir, "forge.plugin.yaml");
    if (!(await io.exists(manifestPath))) {
      throw new Error(
        `forge.plugin.yaml not found at ${packDir} for pack prefix "${pack.prefix}". ` +
          "Run `forge init` to create manifests for declared skill packs (RFC-0941).",
      );
    }

    let manifestRaw: string;
    try {
      manifestRaw = await io.readFile(manifestPath);
    } catch (error) {
      throw new Error(
        `Failed to read forge.plugin.yaml at ${manifestPath}: ${(error as Error).message}`,
      );
    }
    let manifestParsed: unknown;
    try {
      manifestParsed = parseYaml(manifestRaw);
    } catch (error) {
      throw new Error(
        `forge.plugin.yaml at ${manifestPath} is not valid YAML: ${(error as Error).message}`,
      );
    }
    const manifestResult = forgePluginManifestSchema.safeParse(manifestParsed);
    if (!manifestResult.success) {
      const issues = manifestResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`forge.plugin.yaml at ${manifestPath} failed schema validation: ${issues}`);
    }

    const entries = await io.readdir(packDir);
    for (const entry of entries) {
      if (!entry.isDirectory || !entry.name.startsWith(`${pack.prefix}-`)) continue;
      const skillMdPath = path.join(packDir, entry.name, "SKILL.md");
      if (!(await io.exists(skillMdPath))) continue;
      const content = await io.readFile(skillMdPath);
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const skill: PackSkillEntry = {
        name: entry.name,
        pack: pack.prefix,
        dir: pack.dir,
        path: path.relative(packDir, skillMdPath).replace(/\\/g, "/"),
      };
      if (frontmatter) {
        try {
          const parsed = parseYaml(frontmatter[1]) as Record<string, unknown>;
          if (Array.isArray(parsed["knowledge"])) {
            skill.knowledge = (parsed["knowledge"] as unknown[]).filter(
              (value): value is string => typeof value === "string",
            );
          }
        } catch {
          // Skill validation owns malformed frontmatter diagnostics.
        }
      }
      result.push(skill);
    }
  }
  return result;
}

/**
 * Auto-discover forge skills by scanning the skills/ directory for SKILL.md
 * files and parsing their frontmatter. This replaces the hand-maintained
 * FORGE_SKILLS array — the frontmatter is the single source of truth.
 *
 * Skills are organized as skills/{category}/{name}/SKILL.md.
 */
function discoverForgeSkills(skillsRoot: string): ForgeSkillEntry[] {
  const result: ForgeSkillEntry[] = [];
  if (!fs.existsSync(skillsRoot)) return result;

  for (const categoryDir of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!categoryDir.isDirectory()) continue;
    const category = categoryDir.name;
    const catDirPath = path.join(skillsRoot, category);

    for (const skillDir of fs.readdirSync(catDirPath, { withFileTypes: true })) {
      if (!skillDir.isDirectory()) continue;
      const skillMdPath = path.join(catDirPath, skillDir.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf8");
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) continue;

      let fm: Record<string, unknown>;
      try {
        fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      } catch {
        continue;
      }

      const relPath = path.relative(skillsRoot, skillMdPath).replace(/\\/g, "/");
      result.push({
        name: fm["name"] as string,
        category: fm["category"] as ForgeSkillEntry["category"],
        invocation: fm["invocation"] as ForgeSkillEntry["invocation"],
        concerns: fm["concerns"] as ForgeSkillEntry["concerns"],
        dependsOn: Array.isArray(fm["dependsOn"])
          ? (fm["dependsOn"] as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
        path: `skills/${relPath}`,
        ...(Array.isArray(fm["knowledge"])
          ? {
              knowledge: (fm["knowledge"] as unknown[]).filter(
                (v): v is string => typeof v === "string",
              ),
            }
          : {}),
        ...(Array.isArray(fm["triggerPhrases"])
          ? {
              triggerPhrases: (fm["triggerPhrases"] as unknown[]).filter(
                (v): v is string => typeof v === "string",
              ),
            }
          : {}),
      });
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveSkillsRoot(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "..", "skills"),
    path.resolve(import.meta.dirname, "..", "..", "skills"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
const SKILLS_ROOT = resolveSkillsRoot();
export const FORGE_SKILLS: ForgeSkillEntry[] = discoverForgeSkills(SKILLS_ROOT);

/**
 * RFC-1435: map a canonical skill source file to its `.agents/skills` twin.
 * Same mapping the skill-agents-sync gate encodes — forge skills drop the
 * category dir (`skills/fo/fo-x/SKILL.md` → `<skillsDir>/fo-x/SKILL.md`),
 * `_shared/` keeps its dir, `skills/shared/knowledge/*` maps to
 * `shared-knowledge/*`, and pack skills keep their `<prefix>-<name>` dir.
 * Returns the workspace-root-relative twin path, or null when the input is
 * not a canonical forge/pack skill file.
 */
export function skillAgentsTwin(
  repoRelPath: string,
  workspaceRoot: string,
  config: ForgeConfig,
): string | null {
  const rel = repoRelPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const skillsDir = config.paths.skillsDir.replace(/\\/g, "/").replace(/\/$/, "");

  const forgeRel = path.relative(workspaceRoot, SKILLS_ROOT).replace(/\\/g, "/");
  if (rel === forgeRel || rel.startsWith(`${forgeRel}/`)) {
    const rest = rel.slice(forgeRel.length + 1);
    if (rest.startsWith("_shared/")) return `${skillsDir}/${rest}`;
    const sharedKnowledge = "shared/knowledge/";
    if (rest.startsWith(sharedKnowledge)) {
      return `${skillsDir}/shared-knowledge/${rest.slice(sharedKnowledge.length)}`;
    }
    const segs = rest.split("/");
    if (segs.length < 3) return null;
    return `${skillsDir}/${segs[1]}/${segs.slice(2).join("/")}`;
  }

  for (const pack of config.skillPacks ?? []) {
    const packRel = pack.dir.replace(/\\/g, "/").replace(/\/$/, "");
    if (!rel.startsWith(`${packRel}/`)) continue;
    const rest = rel.slice(packRel.length + 1);
    const segs = rest.split("/");
    if (segs.length < 2) return null;
    return `${skillsDir}/${segs[0]}/${segs.slice(1).join("/")}`;
  }

  return null;
}
