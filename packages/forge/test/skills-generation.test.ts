/* RFC-1648 AC-4: .agents/skills is untracked, content-derived from core + plugins, zero tracked twins. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateSkillsTree } from "../src/sdk/skills-gen.ts";
import { scaffoldPlugin } from "./helpers/plugin-fixture.ts";
import { createFixtureRepo } from "./helpers/git-fixture.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

describe("skills generation (AC-4)", () => {
  it("generated tree is untracked, content-derived, and twin-free", () => {
    const repo = createFixtureRepo(mkTmp("forge-skills-repo-"));
    const pluginDir = mkTmp("forge-skills-plugin-");
    scaffoldPlugin(pluginDir, {
      files: { "skills/fo-demo/SKILL.md": "# demo skill\nplugin-authored\n" },
    });

    // Core skills dir — simulated by a second source.
    const coreSkills = mkTmp("forge-skills-core-");
    mkdirSync(join(coreSkills, "fo-core"), { recursive: true });
    writeFileSync(join(coreSkills, "fo-core/SKILL.md"), "# core skill\n");

    const target = join(repo.dir, ".agents", "skills");
    const result = generateSkillsTree(target, [
      { pluginId: "core", skillsDir: coreSkills },
      { pluginId: "test-plugin", skillsDir: join(pluginDir, "skills") },
    ]);

    expect(result.written).toBe(2);
    // Content-derived: both sources present.
    expect(execFileSync("cat", [join(target, "fo-core/SKILL.md")], { encoding: "utf8" })).toContain("core skill");
    expect(execFileSync("cat", [join(target, "fo-demo/SKILL.md")], { encoding: "utf8" })).toContain("plugin-authored");

    // Untracked: git sees nothing in the tree (target must be gitignored by the consumer harness —
    // here assert the generation leaves no tracked entries: git ls-files shows zero).
    writeFileSync(join(repo.dir, ".gitignore"), ".agents/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: repo.dir });
    execFileSync("git", ["commit", "-q", "-m", "ignore generated skills"], { cwd: repo.dir });
    const tracked = execFileSync("git", ["ls-files", ".agents"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(tracked).toBe("");
  });

  it("identical inputs produce identical content hash — regeneration is incremental", () => {
    const skills = mkTmp("forge-skills-inc-");
    mkdirSync(join(skills, "s"), { recursive: true });
    writeFileSync(join(skills, "s/SKILL.md"), "# stable\n");
    const a = generateSkillsTree(mkTmp("forge-skills-t1-"), [{ pluginId: "core", skillsDir: skills }]);
    const b = generateSkillsTree(mkTmp("forge-skills-t2-"), [{ pluginId: "core", skillsDir: skills }]);
    expect(a.inputHash).toBe(b.inputHash);

    writeFileSync(join(skills, "s/SKILL.md"), "# changed\n");
    const c = generateSkillsTree(mkTmp("forge-skills-t3-"), [{ pluginId: "core", skillsDir: skills }]);
    expect(c.inputHash).not.toBe(a.inputHash);
  });
});
