/*
<MODULE_CONTRACT>
<purpose>Unit tests for RFC-0674/RFC-0677 lifecycle handlers — profile resolution, dry-run, build execution, validate with --artifact and violation parsing.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0674: initial lifecycle handler tests — profile resolution, dry-run, build execution.</item>
  <item>RFC-0677: added tests for --artifact filtering, violation parsing (json/plain), allPassed, empty-state.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";
import { resolveActiveProfile } from "./profile-resolve.ts";
import { runBuild } from "./build.ts";
import { runValidate, parseViolations } from "./validate.ts";
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

// ── runValidate RFC-0677: --artifact, violation parsing, allPassed ─────────

test("runValidate --artifact composition filters to a single artifact in dry-run", async () => {
  const result = await runValidate(
    input({ "dry-run": true, artifact: "composition" }),
    makeContext(tmpDir),
  );
  expect(result.data?.artifacts.length).toBe(1);
  expect(result.data?.artifacts[0].id).toBe("composition");
});

test("runValidate --artifact unknown returns exit 1 with not-declared message", async () => {
  const result = await runValidate(
    input({ "dry-run": true, artifact: "nonexistent" }),
    makeContext(tmpDir),
  );
  expect(result.exitCode).toBe(1);
  expect(result.summary).toContain("not declared");
});

test("runValidate --dry-run includes passed and violations fields", async () => {
  const result = await runValidate(input({ "dry-run": true }), makeContext(tmpDir));
  expect(result.data?.allPassed).toBe(true);
  const composition = result.data?.artifacts.find((a) => a.id === "composition");
  expect(composition?.passed).toBe(true);
  expect(composition?.violations).toEqual([]);
});

test("parseViolations extracts structured violations from JSON output", () => {
  const jsonOutput = JSON.stringify([
    { file: "intro.html", line: 12, severity: "error", message: "missing src" },
    { file: "outro.html", line: 5, severity: "warning", message: "deprecated attr" },
  ]);
  const violations = parseViolations(jsonOutput, "json", undefined);
  expect(violations.length).toBe(2);
  expect(violations[0].file).toBe("intro.html");
  expect(violations[0].line).toBe(12);
  expect(violations[0].severity).toBe("error");
  expect(violations[1].severity).toBe("warning");
});

test("parseViolations extracts structured violations from plain text with regex", () => {
  const plainOutput = [
    "compositions/intro.html:12: error: ef-video element missing src attribute",
    "compositions/outro.html:5: warning: deprecated attribute poster",
  ].join("\n");
  const pattern =
    "^(?<file>[^:]+):(?<line>\\d+):\\s*(?<severity>error|warning):\\s*(?<message>.+)$";
  const violations = parseViolations(plainOutput, "plain", pattern);
  expect(violations.length).toBe(2);
  expect(violations[0].file).toBe("compositions/intro.html");
  expect(violations[0].line).toBe(12);
  expect(violations[0].severity).toBe("error");
  expect(violations[0].message).toContain("missing src");
  expect(violations[1].severity).toBe("warning");
});

test("parseViolations returns empty array when outputFormat is not set", () => {
  const violations = parseViolations("some output", undefined, undefined);
  expect(violations).toEqual([]);
});

test("parseViolations returns empty array on malformed JSON", () => {
  const violations = parseViolations("not json", "json", undefined);
  expect(violations).toEqual([]);
});

test("parseViolations returns empty array on malformed regex pattern", () => {
  const violations = parseViolations("some output", "plain", "[invalid(");
  expect(violations).toEqual([]);
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
