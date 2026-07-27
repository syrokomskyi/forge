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

export const FORGE_SKILLS: ForgeSkillEntry[] = [
  // fo skills (21)
  {
    name: "fo-idea",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-idea/SKILL.md",
  },
  {
    name: "fo-idea-create-rfc",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences", "grilling"],
    path: "skills/fo/fo-idea-create-rfc/SKILL.md",
  },
  {
    name: "fo-idea-create-adr",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-idea-create-adr/SKILL.md",
  },
  {
    name: "fo-idea-audit",
    category: "fo",
    invocation: "user",
    concerns: "read-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-idea-audit/SKILL.md",
  },
  {
    name: "fo-idea-enhance",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences", "grilling"],
    path: "skills/fo/fo-idea-enhance/SKILL.md",
  },
  {
    name: "fo-idea-implement",
    category: "fo",
    invocation: "user",
    concerns: "code-mutation",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-idea-implement/SKILL.md",
  },
  {
    name: "fo-idea-plan",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences", "grilling"],
    path: "skills/fo/fo-idea-plan/SKILL.md",
  },
  {
    name: "fo-extract-dna",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-extract-dna/SKILL.md",
  },
  {
    name: "fo-review",
    category: "fo",
    invocation: "user",
    concerns: "read-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-review/SKILL.md",
  },
  {
    name: "fo-fix",
    category: "fo",
    invocation: "user",
    concerns: "code-mutation",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-fix/SKILL.md",
  },
  {
    name: "fo-doc-audit",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-doc-audit/SKILL.md",
  },
  {
    name: "fo-add-tests",
    category: "fo",
    invocation: "user",
    concerns: "code-mutation",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-add-tests/SKILL.md",
  },
  {
    name: "fo-architecture",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences", "grilling"],
    path: "skills/fo/fo-architecture/SKILL.md",
  },
  {
    name: "fo-handoff",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-handoff/SKILL.md",
  },
  {
    name: "fo-triage",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences", "grilling"],
    path: "skills/fo/fo-triage/SKILL.md",
  },
  {
    name: "fo-qa",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-qa/SKILL.md",
  },
  {
    name: "fo-session-save",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-session-save/SKILL.md",
    knowledge: ["qa-log.md", "learned-principles.md", "fix-patterns.md"],
  },
  {
    name: "fo-idea-status",
    category: "fo",
    invocation: "user",
    concerns: "read-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-idea-status/SKILL.md",
  },
  {
    name: "fo-idea-i-just-want-to-see-the-plan",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences", "fo-idea-i-just-want-to-see-the-result"],
    path: "skills/fo/fo-idea-i-just-want-to-see-the-plan/SKILL.md",
  },
  {
    name: "fo-idea-i-just-want-to-see-the-result",
    category: "fo",
    invocation: "user",
    concerns: "code-mutation",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-idea-i-just-want-to-see-the-result/SKILL.md",
  },
  // shared skills (4)
  {
    name: "grilling",
    category: "shared",
    invocation: "user",
    concerns: "read-only",
    dependsOn: ["my-preferences"],
    path: "skills/shared/grilling/SKILL.md",
    knowledge: ["qa-log.md", "learned-principles.md"],
  },
  {
    name: "writing-great-skills",
    category: "shared",
    invocation: "user",
    concerns: "read-only",
    dependsOn: [],
    path: "skills/shared/writing-great-skills/SKILL.md",
  },
  {
    name: "windows-ai-tooling",
    category: "shared",
    invocation: "user",
    concerns: "document-only",
    dependsOn: [],
    path: "skills/shared/windows-ai-tooling/SKILL.md",
  },
  {
    name: "my-preferences",
    category: "shared",
    invocation: "user",
    concerns: "document-only",
    dependsOn: [],
    path: "skills/shared/my-preferences/SKILL.md",
  },
  // meta skills (3)
  {
    name: "skill-create",
    category: "meta",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["grilling", "writing-great-skills"],
    path: "skills/meta/skill-create/SKILL.md",
  },
  {
    name: "port-to-forge",
    category: "meta",
    invocation: "user",
    concerns: "code-mutation",
    dependsOn: ["grilling"],
    path: "skills/meta/port-to-forge/SKILL.md",
  },
  {
    name: "forge-bootstrap",
    category: "meta",
    invocation: "user",
    concerns: "content-mutation",
    dependsOn: ["my-preferences"],
    path: "skills/meta/forge-bootstrap/SKILL.md",
  },
  {
    name: "fo-harvest",
    category: "fo",
    invocation: "user",
    concerns: "code-mutation",
    dependsOn: ["my-preferences", "grilling"],
    path: "skills/fo/fo-harvest/SKILL.md",
  },
  {
    name: "fo-spec-ingest",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences", "grilling"],
    path: "skills/fo/fo-spec-ingest/SKILL.md",
  },
  {
    name: "fo-session-retro",
    category: "fo",
    invocation: "user",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-session-retro/SKILL.md",
  },
  {
    name: "fo-compass-annotate",
    category: "fo",
    invocation: "user",
    concerns: "content-mutation",
    dependsOn: ["my-preferences"],
    path: "skills/fo/fo-compass-annotate/SKILL.md",
  },
];
