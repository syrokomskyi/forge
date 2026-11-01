/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.doctor autonomy guard — verifies @warpgogol/* import detection.</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
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

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
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
    'import { foo } from "@warpgogol/werkstatt-engine/kernel";\nexport const x = foo;',
    "utf8",
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("fail");
  expect(result.data?.forbiddenImports.length).toBe(1);
  expect(result.data?.forbiddenImports[0]?.specifier).toBe("@warpgogol/werkstatt-engine/kernel");
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
    "/* Do not import from @warpgogol/werkstatt-engine/kernel */\nexport const x = 1;",
    "utf8",
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("pass");
  expect(result.data?.forbiddenImports).toEqual([]);
});

test("doctor skips autonomy-guard on an npm-installed forge", async () => {
  // The published tarball ships src/ — a scan there reports findings the
  // consumer cannot act on. node_modules in the resolved path marks it.
  const pkg = join(tempDir, "node_modules", "@warpgogol", "forge");
  await mkdir(join(pkg, "src"), { recursive: true });
  await writeFile(join(pkg, "package.json"), '{"name":"@warpgogol/forge"}', "utf8");
  await writeFile(
    join(pkg, "src", "bad.ts"),
    'import { foo } from "@warpgogol/werkstatt-engine/kernel";\nexport const x = foo;',
    "utf8",
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("pass");
  expect(autonomyCheck?.message).toContain("npm-installed forge");
  expect(result.data?.forbiddenImports).toEqual([]);
});

test("doctor exempts the os/werkstatt/ adapter boundary", async () => {
  // RFC-0940: os/werkstatt/ is the declared werkstatt-adapter module — it may
  // import @warpgogol/werkstatt-engine at runtime.
  const dir = join(tempDir, "packages", "forge", "os", "werkstatt", "handlers");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  await writeFile(
    join(dir, "session-close.ts"),
    'import { SessionEntry } from "@warpgogol/werkstatt-engine/werkstatt";\nexport const x = SessionEntry;',
    "utf8",
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("pass");
  expect(result.data?.forbiddenImports).toEqual([]);
});

test("doctor exempts type-only @warpgogol/* imports", async () => {
  // ADR-0019: import type statements are erased at compile time — exempt.
  await mkdir(join(tempDir, "packages", "forge", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  await writeFile(
    join(tempDir, "packages", "forge", "src", "types.ts"),
    'import type { WorkspaceIO } from "@warpgogol/werkstatt-shared/kernel/workspace-io";\nexport const x = 1;',
    "utf8",
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("pass");
  expect(result.data?.forbiddenImports).toEqual([]);
});

test("doctor exempts werkstatt-shared in os/ modules but flags the engine there", async () => {
  const dir = join(tempDir, "packages", "forge", "os", "mission", "handlers");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  // werkstatt-shared is exempt shared infrastructure even at runtime.
  await writeFile(
    join(dir, "archive.ts"),
    'import { guard } from "@warpgogol/werkstatt-shared/kernel/ship-inflight";\nexport const x = guard;',
    "utf8",
  );

  const sharedResult = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  expect(
    sharedResult.data?.checks.find((c) => c.name === "autonomy-guard")?.status,
  ).toBe("pass");

  await writeFile(
    join(dir, "engine-coupling.ts"),
    'import { kernel } from "@warpgogol/werkstatt-engine/kernel";\nexport const y = kernel;',
    "utf8",
  );

  const engineResult = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const check = engineResult.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(check?.status).toBe("fail");
  expect(engineResult.data?.forbiddenImports[0]?.specifier).toBe(
    "@warpgogol/werkstatt-engine/kernel",
  );
});

test("doctor flags runtime werkstatt-shared imports in src/", async () => {
  // src/ is portable: any runtime @warpgogol/* binding is forbidden there.
  await mkdir(join(tempDir, "packages", "forge", "src"), { recursive: true });
  await writeFile(
    join(tempDir, "packages", "forge", "package.json"),
    '{"name":"@warpgogol/forge"}',
    "utf8",
  );
  await writeFile(
    join(tempDir, "packages", "forge", "src", "io-binding.ts"),
    'import { createDefaultIO } from "@warpgogol/werkstatt-shared/kernel/io";\nexport const io = createDefaultIO;',
    "utf8",
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("fail");
  expect(result.data?.forbiddenImports[0]?.specifier).toBe(
    "@warpgogol/werkstatt-shared/kernel/io",
  );
});

test("doctor skips test files, spec files, declarations and dist/", async () => {
  const forgeRoot = join(tempDir, "packages", "forge");
  await mkdir(join(forgeRoot, "src"), { recursive: true });
  await mkdir(join(forgeRoot, "dist", "os"), { recursive: true });
  await writeFile(join(forgeRoot, "package.json"), '{"name":"@warpgogol/forge"}', "utf8");
  await writeFile(
    join(forgeRoot, "src", "fixture.test.ts"),
    'import { foo } from "@warpgogol/werkstatt-engine/kernel";\n',
    "utf8",
  );
  await writeFile(
    join(forgeRoot, "src", "fixture.spec.ts"),
    'import { foo } from "@warpgogol/werkstatt-engine/kernel";\n',
    "utf8",
  );
  await writeFile(
    join(forgeRoot, "dist", "os", "handler.d.ts"),
    'import { foo } from "@warpgogol/werkstatt-engine/kernel";\n',
    "utf8",
  );

  const result = await runDoctor({ argv: [], flags: {} }, mockContext(tempDir));
  const autonomyCheck = result.data?.checks.find((c) => c.name === "autonomy-guard");
  expect(autonomyCheck?.status).toBe("pass");
  expect(result.data?.forbiddenImports).toEqual([]);
});
