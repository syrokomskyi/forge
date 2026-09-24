/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge memory.compact — mechanical MEMORY.md budget
enforcement via oldest-first Environment notes truncation (RFC-1151).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1151: initial memory.compact tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryCompact, compactMemoryMd } from "../onboarding/memory-compact.ts";
import type { ForgeRuntimeContext } from "../types.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "memory-compact-test-"));
  await mkdir(join(tempDir, ".agents", "memory"), { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeContext(dryRun = false): ForgeRuntimeContext {
  return {
    workspaceRoot: tempDir,
    logger: {
      section: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      info: () => {},
    },
    dryRun,
    outputFormat: "json",
  };
}

function memoryMd(envBullets: number, bulletSize = 200): string {
  const env = Array.from(
    { length: envBullets },
    (_, i) => `- env note ${i} ${"x".repeat(bulletSize)}`,
  ).join("\n");
  return [
    "# Project Memory",
    "",
    "## Current focus",
    "",
    "- keep me",
    "",
    "## Decisions in flight",
    "",
    "- keep me too",
    "",
    "## Environment notes",
    "",
    env,
    "",
  ].join("\n");
}

test("compactMemoryMd removes oldest Environment notes bullets until within budget", () => {
  const content = memoryMd(20);
  const budget = 2000;
  const { lines, removedLines, fitsBudget } = compactMemoryMd(content, budget);

  expect(fitsBudget).toBe(true);
  expect(removedLines.length).toBeGreaterThan(0);
  // Oldest-first: env note 0 removed before env note 19
  expect(removedLines[0]).toContain("env note 0");
  expect(lines.join("\n").length).toBeLessThanOrEqual(budget);
  // Protected sections untouched
  expect(lines.join("\n")).toContain("- keep me");
  expect(lines.join("\n")).toContain("- keep me too");
});

test("compactMemoryMd returns empty removedLines when already within budget", () => {
  const content = memoryMd(2, 10);
  const { removedLines, fitsBudget } = compactMemoryMd(content, 4096);
  expect(removedLines).toHaveLength(0);
  expect(fitsBudget).toBe(true);
});

test("runMemoryCompact writes compacted file and reports removed count", async () => {
  const content = memoryMd(30);
  await writeFile(join(tempDir, ".agents", "memory", "MEMORY.md"), content, "utf8");

  const result = await runMemoryCompact({ argv: [], flags: {} }, makeContext());
  expect(result.exitCode).toBe(0);
  expect(result.data?.status).toBe("pass");
  expect(result.data?.removed).toBeGreaterThan(0);
  expect(result.data?.remainingChars).toBeLessThanOrEqual(result.data!.budget);

  const after = await readFile(join(tempDir, ".agents", "memory", "MEMORY.md"), "utf8");
  expect(after.length).toBeLessThanOrEqual(result.data!.budget);
  expect(after).toContain("- keep me");
});

test("runMemoryCompact dryRun reports without writing", async () => {
  const content = memoryMd(30);
  await writeFile(join(tempDir, ".agents", "memory", "MEMORY.md"), content, "utf8");

  const result = await runMemoryCompact({ argv: [], flags: {} }, makeContext(true));
  expect(result.exitCode).toBe(0);
  expect(result.data?.removed).toBeGreaterThan(0);
  expect(result.data?.removedLines?.length).toBe(result.data?.removed);

  const after = await readFile(join(tempDir, ".agents", "memory", "MEMORY.md"), "utf8");
  expect(after).toBe(content);
});

test("runMemoryCompact passes when MEMORY.md absent", async () => {
  const result = await runMemoryCompact({ argv: [], flags: {} }, makeContext());
  expect(result.exitCode).toBe(0);
  expect(result.data?.removed).toBe(0);
});

test("runMemoryCompact fails when protected sections alone exceed budget", async () => {
  // Huge Current focus — Environment notes empty, nothing removable
  const content = [
    "# Project Memory",
    "",
    "## Current focus",
    "",
    `- ${"y".repeat(6000)}`,
    "",
    "## Environment notes",
    "",
    "- small note",
    "",
  ].join("\n");
  await writeFile(join(tempDir, ".agents", "memory", "MEMORY.md"), content, "utf8");

  const result = await runMemoryCompact({ argv: [], flags: {} }, makeContext());
  expect(result.exitCode).toBe(1);
  expect(result.data?.status).toBe("fail");
  expect(result.data?.errors[0]).toContain("manual editorial compaction");
});
