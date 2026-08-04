/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-0674 lifecycle handlers — profile resolution, dry-run, build execution.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0674: initial lifecycle handler tests — profile resolution, dry-run, build execution.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";
import { resolveActiveProfile } from "./profile-resolve.ts";
import { runBuild } from "./build.ts";
import { runValidate } from "./validate.ts";
import { runDev } from "./dev.ts";

const FORGE_ROOT = join(import.meta.dirname, "..", "..", "..");

function makeTempWorkspace(profileYaml?: string): string {
  const dir = join(
    tmpdir(),
    `forge-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });

  if (profileYaml) {
    writeFileSync(join(dir, "forge.yaml"), profileYaml);
  }

  return dir;
}

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun: false,
    outputFormat: "pretty",
    forgeRoot: FORGE_ROOT,
  };
}

const input = (flags: Record<string, unknown> = {}): ForgeCommandInput => ({
  argv: [],
  flags: flags as Record<string, boolean | string | string[]>,
});

const editframeYaml = `profile: editframe-html\n`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempWorkspace(editframeYaml);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── resolveActiveProfile ──────────────────────────────────────────────────

test("resolveActiveProfile returns the editframe-html profile when forge.yaml declares it", () => {
  const resolved = resolveActiveProfile(tmpDir, FORGE_ROOT);
  expect(resolved).not.toBeNull();
  expect(resolved!.profile.id).toBe("editframe-html");
});

test("resolveActiveProfile returns null when forge.yaml has no profile field", () => {
  const dir = makeTempWorkspace(`project:\n  name: test\n`);
  const resolved = resolveActiveProfile(dir, FORGE_ROOT);
  expect(resolved).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("resolveActiveProfile returns null when forge.yaml is missing", () => {
  const dir = makeTempWorkspace();
  const resolved = resolveActiveProfile(dir, FORGE_ROOT);
  expect(resolved).toBeNull();
});

test("resolveActiveProfile uses profileIdOverride when provided", () => {
  const resolved = resolveActiveProfile(tmpDir, FORGE_ROOT, "editframe-html");
  expect(resolved).not.toBeNull();
  expect(resolved!.profile.id).toBe("editframe-html");
});

// ── runBuild ───────────────────────────────────────────────────────────────

test("runBuild --dry-run does not execute child process and prints resolved commands", async () => {
  const result = await runBuild(input({ "dry-run": true }), makeContext(tmpDir));
  expect(result.exitCode).toBeUndefined();
  expect(result.data?.profileId).toBe("editframe-html");
  expect(result.data?.artifacts.length).toBeGreaterThan(0);
  const composition = result.data?.artifacts.find((a) => a.id === "composition");
  expect(composition).toBeDefined();
  expect(composition!.command).toBe("editframe render");
});

test("runBuild returns exit 1 when no active profile found", async () => {
  const dir = makeTempWorkspace();
  const result = await runBuild(input({}), makeContext(dir));
  expect(result.exitCode).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("runBuild --dry-run resolves commands without execution", async () => {
  const result = await runBuild(input({ "dry-run": true }), makeContext(tmpDir));
  expect(result.data?.artifacts.length).toBeGreaterThan(0);
  expect(result.summary).toContain("[dry-run]");
});

// ── runValidate ─────────────────────────────────────────────────────────────

test("runValidate --dry-run does not execute child process and prints resolved commands", async () => {
  const result = await runValidate(input({ "dry-run": true }), makeContext(tmpDir));
  expect(result.data?.profileId).toBe("editframe-html");
  expect(result.data?.artifacts.length).toBeGreaterThan(0);
  const composition = result.data?.artifacts.find((a) => a.id === "composition");
  expect(composition).toBeDefined();
  expect(composition!.command).toBe("editframe check");
});

test("runValidate returns exit 1 when no active profile found", async () => {
  const dir = makeTempWorkspace();
  const result = await runValidate(input({}), makeContext(dir));
  expect(result.exitCode).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

// ── runDev ──────────────────────────────────────────────────────────────────

test("runDev --dry-run does not spawn child process and prints resolved command", async () => {
  const result = await runDev(input({ "dry-run": true }), makeContext(tmpDir));
  expect(result.data?.profileId).toBe("editframe-html");
  expect(result.data?.devServerCommand).toBe("editframe preview");
  expect(result.data?.port).toBe(4321);
  expect(result.data?.exitCode).toBe(0);
});

test("runDev returns exit 1 when profile has no devServer", async () => {
  // astro-typescript-turborepo profile has no devServer
  const dir = makeTempWorkspace(`profile: astro-typescript-turborepo\n`);
  const result = await runDev(input({}), makeContext(dir));
  expect(result.exitCode).toBe(1);
  expect(result.summary).toContain("does not declare a devServer");
  rmSync(dir, { recursive: true, force: true });
});

test("runDev returns exit 1 when no active profile found", async () => {
  const dir = makeTempWorkspace();
  const result = await runDev(input({}), makeContext(dir));
  expect(result.exitCode).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});
