/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.create command — composes scaffold + init + package-manager post-processing.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0544: initial forge.create tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "node:fs/promises";
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
const WORKSPACE_ROOT = join(FORGE_ROOT, "..", "..");

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

test("forge create my-project creates dir with forge.yaml and docs dirs", async () => {
  const result = await runCreate(
    { argv: ["my-project"], args: ["my-project"], flags: {} },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);
  expect(result.data?.status).toBe("pass");

  const projectDir = join(tempDir, "my-project");
  expect(existsSync(join(projectDir, "forge.yaml"))).toBe(true);
  expect(existsSync(join(projectDir, "docs", "rfcs"))).toBe(true);
  expect(existsSync(join(projectDir, "docs", "adrs"))).toBe(true);
  expect(existsSync(join(projectDir, "PREFERENCES.md"))).toBe(true);
  expect(existsSync(join(projectDir, "package.json"))).toBe(true);
  expect(existsSync(join(projectDir, "scripts", "clean.mjs"))).toBe(true);
}, 30000);

test("forge create refuses non-empty target directory", async () => {
  const targetDir = join(tempDir, "existing-project");
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, "some-file.txt"), "hello", "utf8");

  const result = await runCreate(
    { argv: ["existing-project"], args: ["existing-project"], flags: {} },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("not empty");
});

test("forge create fails on non-kebab-case name", async () => {
  const result = await runCreate(
    { argv: ["MyProject"], args: ["MyProject"], flags: {} },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("kebab-case");
});

test("forge create fails on missing name", async () => {
  const result = await runCreate({ argv: [], args: [], flags: {} }, makeContext(tempDir));
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("Missing required");
});

test("forge create uses forge-shell profile by default", async () => {
  const result = await runCreate(
    { argv: ["my-project"], args: ["my-project"], flags: {} },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);
  expect(result.data?.profile).toBe("forge-shell");
});

test("forge create --package-manager npm writes npm into forge.yaml with npx bindings", async () => {
  const result = await runCreate(
    { argv: ["my-project"], args: ["my-project"], flags: { "package-manager": "npm" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const config = loadForgeConfig(join(tempDir, "my-project"));
  expect(config.project.packageManager).toBe("npm");
  expect(config.bindings?.commands.validateRfc).toContain("npx");
  expect(config.bindings?.commands.validateRfc).toContain("forge rfc.validate");
});

test("forge create --package-manager pnpm writes pnpm into forge.yaml", async () => {
  const result = await runCreate(
    { argv: ["my-project"], args: ["my-project"], flags: { "package-manager": "pnpm" } },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const config = loadForgeConfig(join(tempDir, "my-project"));
  expect(config.project.packageManager).toBe("pnpm");
  expect(config.bindings?.commands.validateRfc).toContain("pnpm exec");
});

test("forge.yaml has non-null forge-CLI bindings and null stack bindings", async () => {
  await runCreate({ argv: ["my-project"], args: ["my-project"], flags: {} }, makeContext(tempDir));

  const config = loadForgeConfig(join(tempDir, "my-project"));
  expect(config.bindings?.commands.validateRfc).not.toBeNull();
  expect(config.bindings?.commands.validateAdr).not.toBeNull();
  expect(config.bindings?.commands.implementStamp).not.toBeNull();
  expect(config.bindings?.commands.specValidate).not.toBeNull();
  expect(config.bindings?.commands.sessionSave).not.toBeNull();
  expect(config.bindings?.commands.typecheck).toBeNull();
  expect(config.bindings?.commands.test).toBeNull();
  expect(config.bindings?.commands.scopedBuild).toBeNull();
});

test("forge.yaml has forge.syncedVersion set", async () => {
  await runCreate({ argv: ["my-project"], args: ["my-project"], flags: {} }, makeContext(tempDir));

  const config = loadForgeConfig(join(tempDir, "my-project"));
  expect(config.forge?.syncedVersion).toBeTruthy();
});

test("result includes nextSteps with Windsurf and forge-bootstrap", async () => {
  const result = await runCreate(
    { argv: ["my-project"], args: ["my-project"], flags: {} },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);
  expect(result.nextSteps).toBeDefined();
  expect(result.nextSteps?.some((s) => s.action.includes("Windsurf"))).toBe(true);
  expect(result.nextSteps?.some((s) => s.action.includes("forge-bootstrap"))).toBe(true);
});

test("forge create generates AGENTS.md with behavioral layer (RFC-0548)", async () => {
  const result = await runCreate(
    { argv: ["my-project"], args: ["my-project"], flags: {} },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const agentsMdPath = join(tempDir, "my-project", "AGENTS.md");
  expect(existsSync(agentsMdPath)).toBe(true);

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const agentsMd = await readFileAsync(agentsMdPath, "utf8");
  expect(agentsMd).toContain("<!-- forge:begin behavioral-layer -->");
  expect(agentsMd).toContain("<!-- forge:end behavioral-layer -->");
  expect(agentsMd).toContain("### Intent-to-skill routing");
});

test("forge create writes NEXT_STEPS.md with greenfield and transplant guidance (RFC-0550)", async () => {
  const result = await runCreate(
    { argv: ["my-project"], args: ["my-project"], flags: {} },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const nextStepsPath = join(tempDir, "my-project", "NEXT_STEPS.md");
  expect(existsSync(nextStepsPath)).toBe(true);

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const nextSteps = await readFileAsync(nextStepsPath, "utf8");
  expect(nextSteps).toContain("Option A: Start creating");
  expect(nextSteps).toContain("Option B: Bring your existing project");
  expect(nextSteps).toContain("AI agent");
  expect(result.data?.filesCreated).toContain("NEXT_STEPS.md");
});

test("forge create root package.json has scripts and replaced project name", async () => {
  const result = await runCreate(
    { argv: ["my-project"], args: ["my-project"], flags: {} },
    makeContext(tempDir),
  );
  expect(result.exitCode).toBe(0);

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const pkgJson = JSON.parse(
    await readFileAsync(join(tempDir, "my-project", "package.json"), "utf8"),
  );
  expect(pkgJson.name).toBe("my-project");
  expect(pkgJson.scripts.clean).toBe("node scripts/clean.mjs");
  expect(pkgJson.scripts.format).toBe("prettier --write .");
  expect(pkgJson.scripts["format:check"]).toBe("prettier --check .");
  expect(pkgJson.scripts.test).toBe("vitest run --passWithNoTests");
  expect(pkgJson.scripts["upgrade-packages"]).toBe("pnpm up");
}, 30000);
