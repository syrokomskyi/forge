/*
<MODULE_CONTRACT>
<purpose>Unit tests for memory-scaffold.ts (RFC-0664) — scaffoldMemoryLayer and checkMemoryLayerHealth.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0664: initial memory scaffold and health check tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldMemoryLayer,
  checkMemoryLayerHealth,
  DEFAULT_MEMORY_BUDGET,
  MEMORY_GITIGNORE_START,
  MEMORY_GITIGNORE_END,
} from "../onboarding/memory-scaffold.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-memory-scaffold-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("scaffoldMemoryLayer creates MEMORY.md, daily/.gitkeep, and .gitignore block", () => {
  const result = scaffoldMemoryLayer(tempDir);

  expect(result.created).toContain(".agents/memory/MEMORY.md");
  expect(result.created).toContain(".agents/memory/daily/.gitkeep");
  expect(result.gitignoreUpdated).toBe(true);
  expect(result.skipped).toEqual([]);

  expect(existsSync(join(tempDir, ".agents", "memory", "MEMORY.md"))).toBe(true);
  expect(existsSync(join(tempDir, ".agents", "memory", "daily", ".gitkeep"))).toBe(true);

  const gitignore = readFileSync(join(tempDir, ".gitignore"), "utf8");
  expect(gitignore).toContain(MEMORY_GITIGNORE_START);
  expect(gitignore).toContain(MEMORY_GITIGNORE_END);
  expect(gitignore).toContain(".agents/memory/daily/");
});

test("scaffoldMemoryLayer is idempotent — second run skips existing files", () => {
  scaffoldMemoryLayer(tempDir);
  const result = scaffoldMemoryLayer(tempDir);

  expect(result.created).toEqual([]);
  expect(result.gitignoreUpdated).toBe(false);
  expect(result.skipped).toContain("MEMORY.md");
  expect(result.skipped).toContain("daily/.gitkeep");
});

test("scaffoldMemoryLayer appends gitignore block to existing .gitignore without clobbering", async () => {
  await writeFile(join(tempDir, ".gitignore"), "node_modules/\ndist/\n", "utf8");

  scaffoldMemoryLayer(tempDir);

  const gitignore = await readFile(join(tempDir, ".gitignore"), "utf8");
  expect(gitignore).toContain("node_modules/");
  expect(gitignore).toContain("dist/");
  expect(gitignore).toContain(MEMORY_GITIGNORE_START);
  expect(gitignore).toContain(".agents/memory/daily/");
  expect(gitignore).toContain(MEMORY_GITIGNORE_END);
});

test("scaffoldMemoryLayer does not duplicate gitignore block on re-run", async () => {
  await writeFile(join(tempDir, ".gitignore"), "node_modules/\n", "utf8");

  scaffoldMemoryLayer(tempDir);
  scaffoldMemoryLayer(tempDir);

  const gitignore = await readFile(join(tempDir, ".gitignore"), "utf8");
  const blockCount = (gitignore.match(new RegExp(MEMORY_GITIGNORE_START, "g")) || []).length;
  expect(blockCount).toBe(1);
});

test("checkMemoryLayerHealth reports pass for healthy layer", () => {
  scaffoldMemoryLayer(tempDir);

  const health = checkMemoryLayerHealth(tempDir);

  expect(health.memoryMdExists).toBe(true);
  expect(health.gitignoreCoversDaily).toBe(true);
  expect(health.dailyFileCount).toBe(0);
  expect(health.budget).toBe(DEFAULT_MEMORY_BUDGET);
  expect(health.memoryMdChars).toBeGreaterThan(0);
});

test("checkMemoryLayerHealth reports missing MEMORY.md", () => {
  const health = checkMemoryLayerHealth(tempDir);

  expect(health.memoryMdExists).toBe(false);
  expect(health.memoryMdChars).toBe(0);
});

test("checkMemoryLayerHealth reports budget from forge.yaml when configured", async () => {
  scaffoldMemoryLayer(tempDir);

  // Write a minimal forge.yaml with memory budget override
  const forgeYaml = `
schema: forge/config@1
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
  sessionsDir: docs/sessions
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
    validate: null
    produce: null
    verify: null
    preview: null
    lint: null
  paths:
    invariantsFile: null
    compassDocs: []
    reviewsDir: null
    handoffsDir: null
    sessionsDir: null
  terminology: {}
  memory:
    budget: 8192
`;
  await mkdir(join(tempDir, "packages", "forge"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    JSON.stringify({ name: "@warpgogol/forge", version: "0.4.0" }),
    "utf8",
  );
  await writeFile(join(tempDir, "forge.yaml"), forgeYaml, "utf8");

  const health = checkMemoryLayerHealth(tempDir);

  expect(health.budget).toBe(8192);
});

test("checkMemoryLayerHealth reports daily file count excluding .gitkeep", async () => {
  scaffoldMemoryLayer(tempDir);

  // Create a daily log file
  await writeFile(
    join(tempDir, ".agents", "memory", "daily", "2026-08-03.md"),
    "- [10:00] test entry\n",
    "utf8",
  );

  const health = checkMemoryLayerHealth(tempDir);

  expect(health.dailyFileCount).toBe(1);
});

test("checkMemoryLayerHealth reports gitignore not covering daily when block absent", async () => {
  scaffoldMemoryLayer(tempDir);

  // Remove the gitignore block
  await writeFile(join(tempDir, ".gitignore"), "node_modules/\n", "utf8");

  const health = checkMemoryLayerHealth(tempDir);

  expect(health.gitignoreCoversDaily).toBe(false);
});

test("checkMemoryLayerHealth uses default budget when forge.yaml absent", () => {
  scaffoldMemoryLayer(tempDir);

  const health = checkMemoryLayerHealth(tempDir);

  expect(health.budget).toBe(DEFAULT_MEMORY_BUDGET);
});
