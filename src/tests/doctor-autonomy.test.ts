/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.doctor autonomy guard — verifies @warpgogol/* import detection.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0391: initial doctor autonomy guard tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../onboarding/doctor.ts";
import type { ForgeRuntimeContext, ForgeLogger } from "../types.ts";

const mockLogger: ForgeLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

const mockContext = (workspaceRoot: string): ForgeRuntimeContext => ({
  workspaceRoot,
  logger: mockLogger,
  dryRun: false,
  outputFormat: "json",
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-doctor-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("doctor passes on clean tree with no @warpgogol/* imports", async () => {
  await mkdir(join(tempDir, "packages", "forge", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  await writeFile(
    join(tempDir, "packages", "forge", "src", "index.ts"),
    "export const x = 1;",
    "utf8",
  );

  const result = await runDoctor({ argv: [], args: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("pass");
  expect(result.data?.forbiddenImports).toEqual([]);
});

test("doctor detects @warpgogol/* import specifiers", async () => {
  await mkdir(join(tempDir, "packages", "forge", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  await writeFile(
    join(tempDir, "packages", "forge", "src", "bad.ts"),
    'import { foo } from "@warpgogol/site-kernel";\nexport const x = foo;',
    "utf8",
  );

  const result = await runDoctor({ argv: [], args: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("fail");
  expect(result.data?.forbiddenImports.length).toBe(1);
  expect(result.data?.forbiddenImports[0]?.specifier).toBe("@warpgogol/site-kernel");
});

test("doctor ignores @warpgogol/* in comments", async () => {
  await mkdir(join(tempDir, "packages", "forge", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  await writeFile(
    join(tempDir, "packages", "forge", "src", "clean.ts"),
    "/* Do not import from @warpgogol/site-kernel */\nexport const x = 1;",
    "utf8",
  );

  const result = await runDoctor({ argv: [], args: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("pass");
  expect(result.data?.forbiddenImports).toEqual([]);
});
