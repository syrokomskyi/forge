/*
<MODULE_CONTRACT>
<purpose>Skill registry — machine-readable array of all forge skills, used by forge.skill.validate and forge.create. Also provides discoverPackSkills helper for project-declared skill packs (RFC-0539).</purpose>
<non-goals>
  <item>Do not include third-party skills — only forge-managed skills belong here.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial ForgeSkillEntry interface and FORGE_SKILLS registry (17 migrated + 3 meta = 20).</item>
  <item>Added fo-add-tests skill (11th fo skill) — absorbs tdd + PBT conventions from RFC-0347.</item>
  <item>Skill consolidation: added fo-architecture, fo-handoff, fo-triage, fo-qa (15 fo skills). Removed handoff, improve-codebase-architecture, to-spec from shared (absorbed into fo-). Shared skills reduced to 4 (grilling, my-preferences, windows-ai-tooling, writing-great-skills).</item>
  <item>Renamed skill prefix wg- → fo- across all skills, paths, and categories. Added fo-idea-status, fo-idea-i-just-want-to-see-the-plan, fo-idea-i-just-want-to-see-the-result (18 fo skills total).</item>
  <item>Added fo-doc-audit skill (19th fo skill) — centralized documentation audit replacing inline AGENTS/README update steps in fo-fix and fo-idea-implement.</item>
  <item>RFC-0395: added fo-spec-ingest skill (20th fo skill) — spec package ingest/authoring with validation, grilling, and acceptance gate.</item>
  <item>Added fo-session-retro skill (21st fo skill) — session-end insight triage, categorizes discoveries and routes to AGENTS.md / ADR / DNA / forge / memory.</item>
  <item>RFC-0523: expanded concerns enum from binary (document-only | implementation) to four-level taxonomy (read-only | document-only | content-mutation | code-mutation). All 30 skills reclassified.</item>
  <item>RFC-0524: added optional knowledge?: string[] field for cumulative knowledge system. Added knowledge arrays to fo-site-scan and grilling.</item>
  <item>RFC-0538: added fo-compass-annotate skill (22nd fo skill) — full-lifecycle Compass header management replacing removed compass.annotate, compass.clear, compass.markup.migrate, compass.invariant.add kernel commands.</item>
  <item>RFC-0539: added discoverPackSkills helper and PackSkillEntry interface for project-declared skill packs. Removed mission-complete and fo-site-scan entries (relocated to warpgogol-skills as wg- pack skills).</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ForgeConfig } from "./config/forge-config.ts";

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
  triggers?: string[];
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
        ...(Array.isArray(fm["triggers"])
          ? {
              triggers: (fm["triggers"] as unknown[]).filter(
                (v): v is string => typeof v === "string",
              ),
            }
          : {}),
      });
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

const SKILLS_ROOT = path.resolve(import.meta.dirname, "..", "skills");
export const FORGE_SKILLS: ForgeSkillEntry[] = discoverForgeSkills(SKILLS_ROOT);
