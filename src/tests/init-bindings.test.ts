/*
<MODULE_CONTRACT>
<purpose>Integration tests for forge.init binding defaults (RFC-0540).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0540: initial init binding defaults integration tests.</item>
  <item>RFC-0552: add test for Forge-vs-pack skill name conflict detection.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../onboarding/init.ts";
import { loadForgeConfig } from "../config/forge-config.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-init-bindings-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function setupForgeSource(dir: string): Promise<void> {
  await mkdir(join(dir, "packages", "forge", "skills"), { recursive: true });
  await writeFile(
    join(dir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  await mkdir(join(dir, "packages", "forge", "os", "rfc"), { recursive: true });
  await writeFile(
    join(dir, "packages", "forge", "os", "rfc", "rfc-0000-template.md"),
    "# RFC Template",
    "utf8",
  );
  await mkdir(join(dir, "packages", "forge", "profiles"), { recursive: true });
}

test("forge.init creates forge.yaml with non-null forge-CLI bindings and null stack bindings", async () => {
  await setupForgeSource(tempDir);

  runInit({ flags: {} }, { workspaceRoot: tempDir });

  const config = loadForgeConfig(tempDir);
  expect(config.bindings).toBeDefined();
  expect(config.bindings?.commands.validateRfc).toBe(
    "pnpm exec forge rfc.validate --id {id} --json",
  );
  expect(config.bindings?.commands.validateAdr).toBe(
    "pnpm exec forge adr.validate --id {id} --json",
  );
  expect(config.bindings?.commands.implementStamp).toBe(
    "pnpm exec forge rfc.implement.stamp --id {id} --implementation-commit {commit}",
  );
  expect(config.bindings?.commands.specValidate).toBe(
    "pnpm exec forge spec.validate --spec={id} --json",
  );
  expect(config.bindings?.commands.sessionSave).toBe("pnpm exec forge session.save --json");
  expect(config.bindings?.commands.typecheck).toBeNull();
  expect(config.bindings?.commands.test).toBeNull();
  expect(config.bindings?.commands.scopedBuild).toBeNull();
});

test("forge.yaml written by forge.init contains forge-CLI binding strings", async () => {
  await setupForgeSource(tempDir);

  runInit({ flags: {} }, { workspaceRoot: tempDir });

  const yamlContent = await readFile(join(tempDir, "forge.yaml"), "utf8");
  expect(yamlContent).toContain("forge rfc.validate");
  expect(yamlContent).toContain("forge adr.validate");
  expect(yamlContent).toContain("forge rfc.implement.stamp");
  expect(yamlContent).toContain("forge spec.validate");
  expect(yamlContent).toContain("forge session.save");
});

test("forge.init does not overwrite existing forge.yaml", async () => {
  await setupForgeSource(tempDir);
  const existingYaml = `schema: forge/config@1
project:
  name: existing
  stack: []
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
bindings:
  schema: forge/bindings@1
  commands:
    validateRfc: "custom command"
    validateAdr: null
    implementStamp: null
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: null
    sessionSave: null
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`;
  await writeFile(join(tempDir, "forge.yaml"), existingYaml, "utf8");

  const result = runInit({ flags: {} }, { workspaceRoot: tempDir });
  expect(result.skipped).toContain("forge.yaml (already exists)");

  const config = loadForgeConfig(tempDir);
  expect(config.bindings?.commands.validateRfc).toBe("custom command");
});

test("RFC-0552: forge.init returns skippedSkills field and syncs non-conflicting pack skills", async () => {
  await setupForgeSource(tempDir);

  // Create a pack with prefix 'wg' containing a non-conflicting skill
  await mkdir(join(tempDir, "packages", "wg-skills", "skills", "wg-custom"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "wg-skills", "skills", "wg-custom", "SKILL.md"),
    "---\nname: wg-custom\n---\n# wg-custom (should be synced)\n",
    "utf8",
  );

  // Write forge.yaml with skillPacks config
  const yaml = `schema: forge/config@1
project:
  name: test-project
  stack: []
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
skillPacks:
  - prefix: wg
    dir: packages/wg-skills/skills
bindings:
  schema: forge/bindings@1
  commands:
    validateRfc: null
    validateAdr: null
    implementStamp: null
    typecheck: null
    test: null
    scopedBuild: null
    specValidate: null
    sessionSave: null
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`;
  await writeFile(join(tempDir, "forge.yaml"), yaml, "utf8");

  const result = runInit(
    { flags: {} },
    { workspaceRoot: tempDir, forgeRoot: join(tempDir, "packages", "forge") },
  );

  // skippedSkills field should exist and be empty (no conflicts)
  expect(result.skippedSkills).toBeDefined();
  expect(result.skippedSkills).toEqual([]);

  // The non-conflicting pack skill should be synced
  const wgSkillPath = join(tempDir, ".agents", "skills", "wg-custom", "SKILL.md");
  expect(existsSync(wgSkillPath)).toBe(true);
});
