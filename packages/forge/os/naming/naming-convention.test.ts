/*
<MODULE_CONTRACT>
<purpose>
Unit tests for naming convention covering runNamingConventionLint. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the naming suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { runNamingConventionLint } from "./naming-convention.ts";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeFlagValue, ForgeRuntimeContext } from "../../src/types.ts";

const noopLogger: ForgeRuntimeContext["logger"] = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
};

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forge-naming-"));
  await mkdir(join(dir, "packages"));
  await mkdir(join(dir, "docs"));
  return dir;
}

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: noopLogger,
    dryRun: false,
    outputFormat: "pretty",
  };
}

function makeInput(flags: Record<string, ForgeFlagValue> = {}): ForgeCommandInput {
  return { argv: [], flags };
}

describe("runNamingConventionLint", () => {
  test("passes on kebab-case filenames", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", "my-file.ts"), "");
      await writeFile(join(dir, "docs", "my-doc.md"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(0);
      expect(result.data?.violations).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flags camelCase filenames", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", "myFile.ts"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(1);
      expect(result.data?.violations).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flags PascalCase filenames", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", "MyFile.ts"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(1);
      expect(result.data?.violations).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("flags underscore filenames", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", "my_file.ts"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(1);
      expect(result.data?.violations).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exempts dotfiles", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", ".eslintrc"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exempts underscore-prefixed files", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", "_shared.ts"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exempts ALLCAPS files", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "docs", "README.md"), "");
      await writeFile(join(dir, "docs", "AGENTS.md"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exempts files with 'config' in the name", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", "astro.config.mjs"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exempts files with 'module' in the name", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", "check.module.ts"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exempts Dockerfile", async () => {
    const dir = await makeTempRepo();
    try {
      await writeFile(join(dir, "packages", "Dockerfile"), "");
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports unknown top-level directories", async () => {
    const dir = await makeTempRepo();
    try {
      await mkdir(join(dir, "UnknownDir"));
      const result = await runNamingConventionLint(makeInput(), makeContext(dir));
      expect(result.data?.unknownTopLevelDirs).toContain("UnknownDir");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
