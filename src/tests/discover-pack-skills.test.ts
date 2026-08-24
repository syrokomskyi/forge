import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverPackSkills } from "../registry.ts";
import { loadForgeConfig } from "../config/forge-config.ts";
import { stringify as stringifyYaml } from "yaml";

describe("discoverPackSkills fail-fast (RFC-0941)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-plugin-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeForgeYaml(skillPacks: Array<{ prefix: string; dir: string }>) {
    const config = {
      schema: "forge/config@1",
      project: {
        name: "test-project",
        stack: [],
        packageManager: "pnpm",
      },
      paths: {
        rfcsDir: "docs/rfcs",
        adrsDir: "docs/adrs",
        plansDir: "docs/plans",
        auditsDir: "docs/audits",
        skillsDir: ".agents/skills",
      },
      skillPacks,
    };
    fs.writeFileSync(path.join(tmpDir, "forge.yaml"), stringifyYaml(config), "utf8");
  }

  function createPackDir(prefix: string, dir: string) {
    const packDir = path.resolve(tmpDir, dir);
    fs.mkdirSync(packDir, { recursive: true });
    return packDir;
  }

  function writeManifest(packDir: string, id: string, version: string) {
    fs.writeFileSync(
      path.join(packDir, "forge.plugin.yaml"),
      stringifyYaml({ id, version }),
      "utf8",
    );
  }

  function writeSkill(packDir: string, prefix: string, skillName: string) {
    const skillDir = path.join(packDir, `${prefix}-${skillName}`);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${prefix}-${skillName}\ndescription: Test skill\nconcerns: read-only\n---\n`,
      "utf8",
    );
  }

  test("throws on missing forge.plugin.yaml manifest", () => {
    const packDir = createPackDir("wg", "skills/wg");
    writeSkill(packDir, "wg", "test");
    writeForgeYaml([{ prefix: "wg", dir: "skills/wg" }]);

    const config = loadForgeConfig(tmpDir);
    expect(() => discoverPackSkills(tmpDir, config)).toThrow(/forge\.plugin\.yaml not found/);
  });

  test("throws on invalid manifest (bad id)", () => {
    const packDir = createPackDir("wg", "skills/wg");
    writeManifest(packDir, "Wg", "1.0.0");
    writeSkill(packDir, "wg", "test");
    writeForgeYaml([{ prefix: "wg", dir: "skills/wg" }]);

    const config = loadForgeConfig(tmpDir);
    expect(() => discoverPackSkills(tmpDir, config)).toThrow(/failed schema validation/);
  });

  test("throws on invalid manifest (bad version)", () => {
    const packDir = createPackDir("wg", "skills/wg");
    writeManifest(packDir, "wg", "not-semver");
    writeSkill(packDir, "wg", "test");
    writeForgeYaml([{ prefix: "wg", dir: "skills/wg" }]);

    const config = loadForgeConfig(tmpDir);
    expect(() => discoverPackSkills(tmpDir, config)).toThrow(/failed schema validation/);
  });

  test("discovers skills when manifest is valid", () => {
    const packDir = createPackDir("wg", "skills/wg");
    writeManifest(packDir, "wg", "1.0.0");
    writeSkill(packDir, "wg", "test");
    writeForgeYaml([{ prefix: "wg", dir: "skills/wg" }]);

    const config = loadForgeConfig(tmpDir);
    const skills = discoverPackSkills(tmpDir, config);
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("wg-test");
    expect(skills[0].pack).toBe("wg");
  });

  test("returns empty array when no skillPacks declared", () => {
    writeForgeYaml([]);
    const config = loadForgeConfig(tmpDir);
    const skills = discoverPackSkills(tmpDir, config);
    expect(skills).toEqual([]);
  });
});
