/*
<MODULE_CONTRACT>
<purpose>
Canonical skills layout resolution — the forge canonical tree (fo/, meta/, shared/
categories + _shared support) generates a flat consumer tree with zero drift surface.
</purpose>
<CHANGE_SUMMARY><item>WP-5 depth.</item></CHANGE_SUMMARY>
*/
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateSkillsTree, resolveCanonicalSkillSources } from "../src/sdk/skills-gen.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

describe("canonical skills layout", () => {
  it("resolves category subtrees and flattens them into the generated root", () => {
    const canonical = mkTmp("forge-canonical-");
    for (const [cat, skill] of [["fo", "fo-demo"], ["meta", "skill-create"], ["shared", "grilling"]] as const) {
      mkdirSync(join(canonical, cat, skill), { recursive: true });
      writeFileSync(join(canonical, cat, skill, "SKILL.md"), `# ${skill}\n`);
    }
    mkdirSync(join(canonical, "_shared"), { recursive: true });
    writeFileSync(join(canonical, "_shared", "agent-operating-model.md"), "# model\n");

    const sources = resolveCanonicalSkillSources(canonical);
    expect(sources.length).toBe(4); // fo + meta + shared + _shared

    const target = mkTmp("forge-gen-target-");
    const result = generateSkillsTree(target, sources);
    expect(result.written).toBe(4);

    // Flattened: category subtrees surface at the generated root.
    
    expect(existsSync(join(target, "fo-demo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "skill-create", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "grilling", "SKILL.md"))).toBe(true);
    // _shared nests — support docs live at _shared/, never flattened to root.
    expect(existsSync(join(target, "_shared", "agent-operating-model.md"))).toBe(true);
    expect(existsSync(join(target, "agent-operating-model.md"))).toBe(false);
  });

  it("the real forge canonical tree resolves all four categories", () => {
    const realCanonical = join(__dirname, "..", "skills");
    const sources = resolveCanonicalSkillSources(realCanonical);
    // fo (34 skills) + meta + shared + _shared all present in the real tree.
    expect(sources.length).toBe(4);
    const target = mkTmp("forge-gen-real-");
    const result = generateSkillsTree(target, sources);
    // 34 fo + 3 meta + 5 shared skills, each with at least SKILL.md — plus _shared files.
    expect(result.written).toBeGreaterThan(40);
  });
});
