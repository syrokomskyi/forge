/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.create command — in-place scaffolding via scaffold + init + package-manager post-processing.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0544: initial forge.create tests.</item>
  <item>RFC-0877: rewrite tests for --in-place mode, add strict empty-directory check and name-derivation tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCreate } from "../onboarding/create.ts";
import { loadForgeConfig } from "../config/forge-config.ts";
import type { ForgeRuntimeContext } from "../types.ts";

const silentLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const FORGE_ROOT = join(import.meta.dirname, "..", "..");
const _WORKSPACE_ROOT = join(FORGE_ROOT, "..", "..");

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: silentLogger as never,
    dryRun: false,
    outputFormat: "json",
    forgeRoot: FORGE_ROOT,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "create-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("forge create --in-place scaffolds in cwd with forge.yaml and docs dirs", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);
  expect(result.data?.status).toBe("pass");

  expect(existsSync(join(tempDir, "forge.yaml"))).toBe(true);
  expect(existsSync(join(tempDir, "docs", "rfcs"))).toBe(true);
  expect(existsSync(join(tempDir, "docs", "adrs"))).toBe(true);
  expect(existsSync(join(tempDir, "PREFERENCES.md"))).toBe(true);
  expect(existsSync(join(tempDir, "package.json"))).toBe(true);
  expect(existsSync(join(tempDir, "scripts", "clean.mjs"))).toBe(true);
}, 30000);

test("forge create --in-place refuses when forge artifacts already exist", async () => {
  await writeFile(join(tempDir, "forge.yaml"), "existing: true", "utf8");

  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("not empty");
});

test("forge create --in-place refuses when non-forge files exist in target directory", async () => {
  await writeFile(join(tempDir, "some-file.txt"), "hello", "utf8");

  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("not empty");
  expect(result.data?.errors[0]).toContain("some-file.txt");
});

test("forge create --in-place tolerates only .git directory in target directory", async () => {
  await mkdir(join(tempDir, ".git"), { recursive: true });

  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);
  expect(result.data?.status).toBe("pass");
  expect(existsSync(join(tempDir, "forge.yaml"))).toBe(true);
  expect(existsSync(join(tempDir, ".git"))).toBe(true);
}, 30000);

test("forge create fails on non-kebab-case name", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "MyProject" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("kebab-case");
});

test("forge create fails on missing --in-place flag", async () => {
  const result = await runCreate(
    { argv: [], flags: { profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("--in-place");
});

test("forge create fails on missing --profile flag", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("--profile");
});

test("forge create --in-place --profile forge-shell uses forge-shell profile", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);
  expect(result.data?.profile).toBe("forge-shell");
}, 30000);

test("forge create --package-manager npm writes npm into forge.yaml with npx bindings", async () => {
  const result = await runCreate(
    {
      argv: [],
      flags: {
        "in-place": true,
        profile: "forge-shell",
        name: "my-project",
        "package-manager": "npm",
      },
    },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const config = loadForgeConfig(tempDir);
  expect(config.project.packageManager).toBe("npm");
  expect(config.bindings?.commands.validateRfc).toContain("npx");
  expect(config.bindings?.commands.validateRfc).toContain("forge rfc.validate");
}, 30000);

test("forge create --package-manager pnpm writes pnpm into forge.yaml", async () => {
  const result = await runCreate(
    {
      argv: [],
      flags: {
        "in-place": true,
        profile: "forge-shell",
        name: "my-project",
        "package-manager": "pnpm",
      },
    },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const config = loadForgeConfig(tempDir);
  expect(config.project.packageManager).toBe("pnpm");
  expect(config.bindings?.commands.validateRfc).toContain("pnpm exec");
}, 30000);

test("forge.yaml has non-null forge-CLI bindings and null stack bindings", async () => {
  await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );

  const config = loadForgeConfig(tempDir);
  expect(config.bindings?.commands.validateRfc).not.toBeNull();
  expect(config.bindings?.commands.validateAdr).not.toBeNull();
  expect(config.bindings?.commands.implementStamp).not.toBeNull();
  expect(config.bindings?.commands.specValidate).not.toBeNull();
  expect(config.bindings?.commands.sessionSave).not.toBeNull();
  expect(config.bindings?.commands.typecheck).toBeNull();
  expect(config.bindings?.commands.test).toBeNull();
  expect(config.bindings?.commands.scopedBuild).toBeNull();
}, 30000);

test("forge.yaml has forge.syncedVersion set", async () => {
  await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );

  const config = loadForgeConfig(tempDir);
  expect(config.forge?.syncedVersion).toBeTruthy();
}, 30000);

test("result includes nextSteps with forge-bootstrap", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);
  expect(result.nextSteps).toBeDefined();
  expect(result.nextSteps?.some((s) => s.action.includes("forge-bootstrap"))).toBe(true);
  expect(result.nextSteps?.some((s) => s.kind === "required")).toBe(true);
}, 30000);

test("forge create generates AGENTS.md with behavioral layer (RFC-0548)", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const agentsMdPath = join(tempDir, "AGENTS.md");
  expect(existsSync(agentsMdPath)).toBe(true);

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const agentsMd = await readFileAsync(agentsMdPath, "utf8");
  expect(agentsMd).toContain("<!-- forge:begin behavioral-layer -->");
  expect(agentsMd).toContain("<!-- forge:end behavioral-layer -->");
  expect(agentsMd).toContain("### Intent-to-skill routing");
}, 30000);

test("forge create writes NEXT_STEPS.md with greenfield and transplant guidance (RFC-0550)", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const nextStepsPath = join(tempDir, "NEXT_STEPS.md");
  expect(existsSync(nextStepsPath)).toBe(true);

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const nextSteps = await readFileAsync(nextStepsPath, "utf8");
  expect(nextSteps).toContain("required");
  expect(nextSteps).toContain("forge-bootstrap");
  expect(nextSteps).toContain("language");
  expect(result.data?.filesCreated).toContain("NEXT_STEPS.md");
}, 30000);

test("forge create root package.json has scripts and replaced project name", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell", name: "my-project" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const pkgJson = JSON.parse(await readFileAsync(join(tempDir, "package.json"), "utf8"));
  expect(pkgJson.name).toBe("my-project");
  expect(pkgJson.scripts.clean).toBe("node scripts/clean.mjs");
  expect(pkgJson.scripts.format).toBe("prettier --write .");
  expect(pkgJson.scripts["format:check"]).toBe("prettier --check .");
  expect(pkgJson.scripts.test).toBe("vitest run --passWithNoTests");
  expect(pkgJson.scripts["upgrade-packages"]).toBe("pnpm up");
}, 30000);

test("forge create --in-place derives name from folder name when --name omitted", async () => {
  const namedDir = join(tempDir, "my-derived-project");
  await mkdir(namedDir, { recursive: true });

  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "forge-shell" } },
    makeContext(namedDir),
  );
  expect(result.exitCode).toBe(0);
  expect(result.data?.status).toBe("pass");

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const pkgJson = JSON.parse(await readFileAsync(join(namedDir, "package.json"), "utf8"));
  expect(pkgJson.name).toBe("my-derived-project");
}, 30000);

test("forge create --profile godot-csharp writes compass.fileExtensions into forge.yaml", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "godot-csharp", name: "my-game" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const forgeYaml = await readFileAsync(join(tempDir, "forge.yaml"), "utf8");
  expect(forgeYaml).toContain("compass:");
  expect(forgeYaml).toContain("fileExtensions:");
  expect(forgeYaml).toContain(".cs");
  expect(forgeYaml).toContain(".tscn");
  expect(forgeYaml).toContain(".tres");
  expect(forgeYaml).toContain(".gd");
}, 30000);

test("forge create --profile phaser-turborepo writes compass.fileExtensions into forge.yaml", async () => {
  const result = await runCreate(
    { argv: [], flags: { "in-place": true, profile: "phaser-turborepo", name: "my-phaser-game" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const forgeYaml = await readFileAsync(join(tempDir, "forge.yaml"), "utf8");
  expect(forgeYaml).toContain("compass:");
  expect(forgeYaml).toContain("fileExtensions:");
}, 30000);
