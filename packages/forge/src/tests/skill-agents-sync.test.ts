/*
<MODULE_CONTRACT>
<purpose>CI gate: every forge/pack skill source must be fully propagated to
`.agents/skills/` (IDE discovery copy written by forge.init/forge.upgrade).
SKILL.md syncs verbatim; declared knowledge files follow the append-only
syncKnowledgeFile contract — in the canonical repo a resync must be a no-op,
otherwise source and copy have drifted apart.</purpose>
<non-goals>
  <item>Do not validate skill content/schema — forge.skill.validate owns that.</item>
  <item>Do not flag unmarked dirs — a missing .forge-managed marker means
    consumer-owned (RFC-1154), e.g. `_shared/`.</item>
</non-goals>
<KEY_DECISIONS>
  <item>planKnowledgeSync is reused so the gate encodes the exact merge
    semantics of the syncer — only "unchanged" is a pass; "merged" (source has
    entries the copy lacks), "copied" (copy missing), and "skipped"
    (non-mergeable divergence = hand-edited copy) all fail.</item>
  <item>Runs on the real repo — this is a drift gate, not a fixture test.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>Initial version — covers FORGE_SKILLS, declared pack skills
    (discoverPackSkills), and the shared-knowledge layer.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadForgeConfig } from "../config/forge-config.ts";
import { planKnowledgeSync } from "../knowledge/index.ts";
import { FORGE_SKILLS, discoverPackSkills } from "../registry.ts";

const forgeRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");

interface SkillSource {
  name: string;
  srcDir: string;
  knowledge: string[];
}

function collectSkillSources(): SkillSource[] {
  const sources: SkillSource[] = [];
  for (const skill of FORGE_SKILLS) {
    sources.push({
      name: skill.name,
      srcDir: path.dirname(path.join(forgeRoot, skill.path)),
      knowledge: skill.knowledge ?? [],
    });
  }
  const config = loadForgeConfig(workspaceRoot);
  for (const skill of discoverPackSkills(workspaceRoot, config)) {
    sources.push({
      name: skill.name,
      srcDir: path.dirname(path.join(workspaceRoot, skill.dir, skill.path)),
      knowledge: skill.knowledge ?? [],
    });
  }
  return sources;
}

// Skipped in the standalone package repo — the gate needs a forge-managed
// workspace root (forge.yaml + synced skillsDir), which only exists for the
// monorepo and consumer projects, not for the published forge source tree.
const hasForgeWorkspace = fs.existsSync(path.join(workspaceRoot, "forge.yaml"));
describe.runIf(hasForgeWorkspace)(
  ".agents/skills sync gate (forge.init/forge.upgrade parity)",
  () => {
    // describe callbacks still run during collection even when runIf is false,
    // so initializers must tolerate the absent forge.yaml themselves.
    const config = hasForgeWorkspace ? loadForgeConfig(workspaceRoot) : null;
    const skillsDir = config ? path.join(workspaceRoot, config.paths.skillsDir) : "";
    const sources = config ? collectSkillSources() : [];

    it("every forge + pack skill has a synced copy in .agents/skills/", () => {
      const missing = sources
        .filter((s) => !fs.existsSync(path.join(skillsDir, s.name, "SKILL.md")))
        .map((s) => `${s.name} (src ${path.relative(workspaceRoot, s.srcDir)})`);
      expect(
        missing,
        `skills never synced — run \`forge init\`/\`forge upgrade\` to populate ${path.relative(workspaceRoot, skillsDir)}`,
      ).toEqual([]);
    });

    it("SKILL.md copies are byte-identical to their sources", () => {
      const drifted: string[] = [];
      for (const s of sources) {
        const src = path.join(s.srcDir, "SKILL.md");
        const dest = path.join(skillsDir, s.name, "SKILL.md");
        if (!fs.existsSync(dest)) continue; // reported by the presence test
        if (fs.readFileSync(src, "utf8") !== fs.readFileSync(dest, "utf8")) {
          drifted.push(s.name);
        }
      }
      expect(
        drifted,
        "SKILL.md drift — edit the pack source and re-sync, never edit .agents/skills/ directly",
      ).toEqual([]);
    });

    it("declared knowledge files are in sync (append-only merge would be a no-op)", () => {
      const stale: string[] = [];
      for (const s of sources) {
        for (const kf of s.knowledge) {
          const src = path.join(s.srcDir, kf);
          const dest = path.join(skillsDir, s.name, kf);
          if (!fs.existsSync(src)) {
            stale.push(`${s.name}/${kf} — declared but missing in source`);
            continue;
          }
          if (!fs.existsSync(dest)) {
            stale.push(`${s.name}/${kf} — missing in .agents/skills (run forge upgrade)`);
            continue;
          }
          const plan = planKnowledgeSync(src, dest);
          if (plan.action === "merged") {
            stale.push(`${s.name}/${kf} — source has entries the copy lacks`);
          } else if (plan.action === "skipped") {
            stale.push(`${s.name}/${kf} — copy diverged non-mergeably (hand-edited .agents copy)`);
          }
        }
      }
      expect(stale).toEqual([]);
    });

    it("undeclared aux files in the copy still match their sources", () => {
      // The syncer writes SKILL.md + declared knowledge files only. Aux files
      // (references, templates, placeholder dirs) that exist in BOTH trees are
      // hand-copied and silently diverge — a same-named pair must stay identical,
      // and a copy-only orphan can never resync.
      const flagged: string[] = [];
      for (const s of sources) {
        const destDir = path.join(skillsDir, s.name);
        if (!fs.existsSync(destDir)) continue;
        const declared = new Set(["SKILL.md", ".forge-managed", ...s.knowledge]);
        for (const entry of fs.readdirSync(destDir)) {
          if (declared.has(entry)) continue;
          const srcEntry = path.join(s.srcDir, entry);
          const destEntry = path.join(destDir, entry);
          if (fs.statSync(destEntry).isDirectory()) {
            if (!fs.existsSync(srcEntry))
              flagged.push(`${s.name}/${entry}/ — dir absent in source`);
            continue;
          }
          if (!fs.existsSync(srcEntry)) {
            flagged.push(`${s.name}/${entry} — absent in source, copy can never resync`);
          } else if (fs.readFileSync(srcEntry, "utf8") !== fs.readFileSync(destEntry, "utf8")) {
            flagged.push(`${s.name}/${entry} — diverged from source`);
          }
        }
      }
      expect(
        flagged,
        "aux-file drift — declare aux files via `knowledge:` in SKILL.md or keep copies identical to source",
      ).toEqual([]);
    });

    it("shared-knowledge layer is synced", () => {
      const src = path.join(forgeRoot, "skills", "shared", "knowledge", "learned-principles.md");
      const dest = path.join(skillsDir, "shared-knowledge", "learned-principles.md");
      if (!fs.existsSync(src)) return; // layer absent — nothing to gate
      expect(fs.existsSync(dest), "shared-knowledge/learned-principles.md not synced").toBe(true);
      const plan = planKnowledgeSync(src, dest);
      expect(plan.action, `shared-knowledge drift (sync action: ${plan.action})`).toBe("unchanged");
    });
  },
);
