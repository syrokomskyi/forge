/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.upgrade handler (RFC-0543) and VERSION sourcing.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0543: initial upgrade handler and VERSION sourcing tests.</item>
  <item>RFC-0552: add test for Forge-vs-pack skill name conflict detection in upgrade.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpgrade } from "../onboarding/upgrade.ts";
import { runInit } from "../onboarding/init.ts";
import {
  loadForgeConfig,
  FORGE_CLI_BINDING_DEFAULTS,
  resolvePmRunner,
} from "../config/forge-config.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-upgrade-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function setupForgeSource(dir: string, version = "0.2.0"): Promise<void> {
  await mkdir(join(dir, "packages", "forge", "skills", "fo", "fo-idea"), { recursive: true });
  await writeFile(
    join(dir, "packages", "forge", "skills", "fo", "fo-idea", "SKILL.md"),
    "---\nname: fo-idea\n---\n# fo-idea\n",
    "utf8",
  );
  await writeFile(
    join(dir, "packages", "forge", "package.json"),
    JSON.stringify({ name: "@warpgogol/forge", version }),
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

async function setupConsumerForgeYaml(
  dir: string,
  syncedVersion: string | null,
  customBindings?: Record<string, string | null>,
): Promise<void> {
  const commands: Record<string, string | null> = {
    validateRfc: null,
    validateAdr: null,
    implementStamp: null,
    typecheck: null,
    test: null,
    scopedBuild: null,
    specValidate: null,
    ...customBindings,
  };
  const forgeSection =
    syncedVersion !== null ? `\nforge:\n  syncedVersion: ${syncedVersion}\n` : "";

  const yaml = `schema: forge/config@1
project:
  name: consumer-project
  stack: []
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
  sessionsDir: docs/sessions
bindings:
  schema: forge/bindings@1
  commands:
    validateRfc: ${commands.validateRfc ? `"${commands.validateRfc}"` : "null"}
    validateAdr: ${commands.validateAdr ? `"${commands.validateAdr}"` : "null"}
    implementStamp: ${commands.implementStamp ? `"${commands.implementStamp}"` : "null"}
    typecheck: ${commands.typecheck ? `"${commands.typecheck}"` : "null"}
    test: ${commands.test ? `"${commands.test}"` : "null"}
    scopedBuild: ${commands.scopedBuild ? `"${commands.scopedBuild}"` : "null"}
    specValidate: ${commands.specValidate ? `"${commands.specValidate}"` : "null"}
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null${forgeSection}`;
  await writeFile(join(dir, "forge.yaml"), yaml, "utf8");
}

function makeContext(workspaceRoot: string, dryRun = false) {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun,
    outputFormat: "json" as const,
    commandRegistry: undefined,
  };
}

test("forge.upgrade --dry-run writes no files", async () => {
  await setupForgeSource(tempDir, "0.2.0");
  await setupConsumerForgeYaml(tempDir, null);

  const result = await runUpgrade(
    { argv: [], args: [], flags: { "dry-run": true } },
    makeContext(tempDir, true),
  );

  expect(result.data?.status).toBe("pass");
  expect(result.data?.skillsUpdated.length).toBeGreaterThan(0);
  // No skills directory should have been created
  expect(existsSync(join(tempDir, ".agents", "skills"))).toBe(false);
  // forge.yaml should still have no forge section
  const yaml = await readFile(join(tempDir, "forge.yaml"), "utf8");
  expect(yaml).not.toContain("syncedVersion: 0.2.0");
});

test("forge.upgrade with syncedVersion: null performs full sync", async () => {
  await setupForgeSource(tempDir, "0.2.0");
  await setupConsumerForgeYaml(tempDir, null);

  const result = await runUpgrade({ argv: [], args: [], flags: {} }, makeContext(tempDir, false));

  expect(result.data?.status).toBe("pass");
  expect(result.data?.fromVersion).toBe("never-synced");
  expect(result.data?.toVersion).toBe("0.2.0");
  expect(result.data?.skillsUpdated.length).toBeGreaterThan(0);

  // syncedVersion should be updated in forge.yaml
  const config = loadForgeConfig(tempDir);
  expect(config.forge?.syncedVersion).toBe("0.2.0");
});

test("forge.upgrade with syncedVersion matching installed version returns noop", async () => {
  await setupForgeSource(tempDir, "0.2.0");
  await setupConsumerForgeYaml(tempDir, "0.2.0");

  const result = await runUpgrade({ argv: [], args: [], flags: {} }, makeContext(tempDir, false));

  expect(result.data?.status).toBe("noop");
  expect(result.data?.fromVersion).toBe("0.2.0");
  expect(result.data?.toVersion).toBe("0.2.0");
  expect(result.data?.skillsUpdated).toEqual([]);
  expect(result.exitCode).toBe(0);
});

test("forge.upgrade never overwrites a non-null operator-set binding", async () => {
  await setupForgeSource(tempDir, "0.2.0");
  await setupConsumerForgeYaml(tempDir, null, {
    validateRfc: "my-custom-validate-command",
  });

  const result = await runUpgrade({ argv: [], args: [], flags: {} }, makeContext(tempDir, false));

  expect(result.data?.status).toBe("pass");

  // The custom binding should be preserved
  const config = loadForgeConfig(tempDir);
  expect(config.bindings?.commands.validateRfc).toBe("my-custom-validate-command");

  // Other null bindings should have been filled with defaults
  const runner = resolvePmRunner("pnpm");
  expect(config.bindings?.commands.validateAdr).toBe(`${runner} forge adr.validate {id} --json`);
  expect(config.bindings?.commands.implementStamp).toBe(
    `${runner} forge rfc.implement.stamp --id {id} --implementation-commit {commit}`,
  );
  expect(config.bindings?.commands.specValidate).toBe(
    `${runner} forge spec.validate --spec={id} --json`,
  );

  // The added bindings should be reported
  const addedKeys = result.data?.bindingsAdded.map((b) => b.key);
  expect(addedKeys).not.toContain("commands.validateRfc");
  expect(addedKeys).toContain("commands.validateAdr");
  expect(addedKeys).toContain("commands.implementStamp");
  expect(addedKeys).toContain("commands.specValidate");
});

test("forge.upgrade refuses when forge.yaml is missing", async () => {
  await setupForgeSource(tempDir, "0.2.0");

  const result = await runUpgrade({ argv: [], args: [], flags: {} }, makeContext(tempDir, false));

  expect(result.data?.status).toBe("fail");
  expect(result.exitCode).toBe(1);
  expect(result.nextSteps?.[0]?.action).toContain("forge create");
});

test("forge.upgrade adds all FORGE_CLI_BINDING_DEFAULTS keys when all are null", async () => {
  await setupForgeSource(tempDir, "0.2.0");
  await setupConsumerForgeYaml(tempDir, null);

  const result = await runUpgrade({ argv: [], args: [], flags: {} }, makeContext(tempDir, false));

  expect(result.data?.bindingsAdded.length).toBe(FORGE_CLI_BINDING_DEFAULTS.length);
});

test("forge.init writes forge.syncedVersion on first init", async () => {
  await setupForgeSource(tempDir, "0.3.0");

  runInit({ flags: {} }, { workspaceRoot: tempDir });

  const config = loadForgeConfig(tempDir);
  expect(config.forge?.syncedVersion).toBe("0.3.0");
});

test("forge.upgrade syncs skills to .agents/skills/", async () => {
  await setupForgeSource(tempDir, "0.2.0");
  await setupConsumerForgeYaml(tempDir, null);

  await runUpgrade({ argv: [], args: [], flags: {} }, makeContext(tempDir, false));

  // Check that fo-idea skill was copied
  const skillPath = join(tempDir, ".agents", "skills", "fo-idea", "SKILL.md");
  expect(existsSync(skillPath)).toBe(true);
  const content = await readFile(skillPath, "utf8");
  expect(content).toContain("fo-idea");
});

test("RFC-0552: forge.upgrade returns skippedSkills field and syncs non-conflicting pack skills", async () => {
  await setupForgeSource(tempDir, "0.2.0");

  // Create a pack with prefix 'wg' containing a non-conflicting skill
  await mkdir(join(tempDir, "packages", "wg-skills", "skills", "wg-custom"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "wg-skills", "skills", "wg-custom", "SKILL.md"),
    "---\nname: wg-custom\n---\n# wg-custom (should be synced)\n",
    "utf8",
  );

  // Write forge.yaml with skillPacks config and null syncedVersion
  const yaml = `schema: forge/config@1
project:
  name: consumer-project
  stack: []
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  plansDir: docs/plans
  auditsDir: docs/audits
  specsDir: docs/specs
  skillsDir: .agents/skills
  sessionsDir: docs/sessions
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
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
`;
  await writeFile(join(tempDir, "forge.yaml"), yaml, "utf8");

  const result = await runUpgrade({ argv: [], args: [], flags: {} }, makeContext(tempDir, false));

  expect(result.data?.status).toBe("pass");

  // skippedSkills field should exist and be empty (no conflicts)
  expect(result.data?.skippedSkills).toBeDefined();
  expect(result.data?.skippedSkills).toEqual([]);

  // The non-conflicting pack skill should be synced
  const wgSkillPath = join(tempDir, ".agents", "skills", "wg-custom", "SKILL.md");
  expect(existsSync(wgSkillPath)).toBe(true);
});
