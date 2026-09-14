/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.public-surface.validate — SURFACE-01..05 rules from RFC-1080.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1080: initial public-surface validator tests covering all 5 rules, exit codes, and monorepo resolution.</item>
  <item>RFC-1088: raise SURFACE-01 threshold from 300 to 600 lines.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPublicSurfaceValidate } from "../../os/core/handlers/public-surface.ts";
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
  tempDir = await mkdtemp(join(tmpdir(), "forge-public-surface-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Create a standalone package layout (no packages/forge/ subdir).
 * Files are written directly into tempDir.
 */
async function setupStandalone(
  dir: string,
  opts: {
    readmeLines?: number;
    readmeContent?: string;
    nodeVersion?: string;
    hasTgz?: boolean;
    docsFiles?: string[];
    rootFiles?: string[];
  } = {},
): Promise<void> {
  const readmeContent =
    opts.readmeContent ??
    Array.from({ length: opts.readmeLines ?? 100 }, (_, i) => `Line ${i}`).join("\n");
  await writeFile(join(dir, "README.md"), readmeContent, "utf8");

  const pkg = {
    name: "@warpgogol/forge",
    version: "1.0.0",
    engines: opts.nodeVersion ? { node: opts.nodeVersion } : undefined,
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg), "utf8");

  if (opts.hasTgz) {
    await writeFile(join(dir, "stale-1.0.0.tgz"), "fake tgz", "utf8");
  }

  const docsFiles = opts.docsFiles ?? [
    "docs/getting-started.md",
    "docs/concepts/why-forge.md",
    "docs/reference/cli.md",
  ];
  for (const f of docsFiles) {
    await mkdir(join(dir, ...f.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dir, f), "# doc", "utf8");
  }

  const rootFiles = opts.rootFiles ?? ["CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"];
  for (const f of rootFiles) {
    await writeFile(join(dir, f), `# ${f}`, "utf8");
  }
}

/**
 * Create a monorepo layout: packages/forge/ subdir with forge package files.
 */
async function setupMonorepo(
  dir: string,
  opts: {
    readmeLines?: number;
    readmeContent?: string;
    nodeVersion?: string;
  } = {},
): Promise<void> {
  await mkdir(join(dir, "packages", "forge"), { recursive: true });
  await setupStandalone(join(dir, "packages", "forge"), opts);
}

test("SURFACE-01: README under 600 lines passes", async () => {
  await setupStandalone(tempDir, { readmeLines: 100 });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface01 = checks.find((c) => c.rule === "SURFACE-01");
  expect(surface01?.status, "README with 100 lines should pass SURFACE-01").toBe("pass");
});

test("SURFACE-01: README at exactly 600 lines passes", async () => {
  await setupStandalone(tempDir, { readmeLines: 600 });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface01 = checks.find((c) => c.rule === "SURFACE-01");
  expect(surface01?.status, "README with 600 lines should pass SURFACE-01").toBe("pass");
});

test("SURFACE-01: README over 600 lines warns", async () => {
  await setupStandalone(tempDir, { readmeLines: 601 });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface01 = checks.find((c) => c.rule === "SURFACE-01");
  expect(surface01?.status, "README with 601 lines should warn on SURFACE-01").toBe("warn");
});

test("SURFACE-02: Node version match passes", async () => {
  await setupStandalone(tempDir, {
    readmeContent: "# Forge\n\nRequires Node.js 24 or newer.\n",
    nodeVersion: ">=24 <25",
  });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface02 = checks.find((c) => c.rule === "SURFACE-02");
  expect(surface02?.status, "Matching Node version should pass SURFACE-02").toBe("pass");
});

test("SURFACE-02: Node version mismatch fails", async () => {
  await setupStandalone(tempDir, {
    readmeContent: "# Forge\n\nRequires Node.js v22.\n",
    nodeVersion: ">=24 <25",
  });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface02 = checks.find((c) => c.rule === "SURFACE-02");
  expect(
    surface02?.status,
    "Node v22 in README but >=24 in package.json should fail SURFACE-02",
  ).toBe("fail");
});

test("SURFACE-02: missing engines.node fails", async () => {
  await setupStandalone(tempDir, { readmeContent: "# Forge\n", nodeVersion: undefined });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface02 = checks.find((c) => c.rule === "SURFACE-02");
  expect(surface02?.status, "Missing engines.node should fail SURFACE-02").toBe("fail");
});

test("SURFACE-03: no .tgz files passes", async () => {
  await setupStandalone(tempDir);
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface03 = checks.find((c) => c.rule === "SURFACE-03");
  expect(surface03?.status, "No .tgz files should pass SURFACE-03").toBe("pass");
});

test("SURFACE-03: .tgz file present fails", async () => {
  await setupStandalone(tempDir, { hasTgz: true });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface03 = checks.find((c) => c.rule === "SURFACE-03");
  expect(surface03?.status, "Presence of .tgz file should fail SURFACE-03").toBe("fail");
});

test("SURFACE-04: all docs files present passes", async () => {
  await setupStandalone(tempDir);
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface04 = checks.find((c) => c.rule === "SURFACE-04");
  expect(surface04?.status, "All docs files present should pass SURFACE-04").toBe("pass");
});

test("SURFACE-04: missing docs file fails", async () => {
  await setupStandalone(tempDir, {
    docsFiles: ["docs/getting-started.md", "docs/concepts/why-forge.md"],
  });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface04 = checks.find((c) => c.rule === "SURFACE-04");
  expect(surface04?.status, "Missing docs/reference/cli.md should fail SURFACE-04").toBe("fail");
});

test("SURFACE-05: all root files present passes", async () => {
  await setupStandalone(tempDir);
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface05 = checks.find((c) => c.rule === "SURFACE-05");
  expect(surface05?.status, "All root files present should pass SURFACE-05").toBe("pass");
});

test("SURFACE-05: missing root file warns", async () => {
  await setupStandalone(tempDir, { rootFiles: ["CONTRIBUTING.md", "SECURITY.md"] });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface05 = checks.find((c) => c.rule === "SURFACE-05");
  expect(surface05?.status, "Missing CHANGELOG.md should warn on SURFACE-05").toBe("warn");
});

test("exit code 0 when all checks pass", async () => {
  await setupStandalone(tempDir, {
    readmeContent: "# Forge\n\nRequires Node.js 24.\n",
    nodeVersion: ">=24 <25",
  });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  expect(result.exitCode, "All checks pass — exit code should be 0").toBe(0);
  expect(result.data?.status, "Overall status should be pass").toBe("pass");
});

test("exit code 1 when any check fails", async () => {
  await setupStandalone(tempDir, { hasTgz: true });
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  expect(result.exitCode, "SURFACE-03 fail — exit code should be 1").toBe(1);
  expect(result.data?.status, "Overall status should be fail").toBe("fail");
});

test("monorepo: reads packages/forge/README.md when packages/forge/ exists", async () => {
  await setupMonorepo(tempDir, {
    readmeContent: "# Forge monorepo\n\nRequires Node.js 24.\n",
    nodeVersion: ">=24 <25",
  });
  // Write a different README at monorepo root to ensure it's NOT read
  await writeFile(join(tempDir, "README.md"), "# Werkstatt root\n\nNode.js v22.\n", "utf8");
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface02 = checks.find((c) => c.rule === "SURFACE-02");
  expect(
    surface02?.status,
    "Monorepo mode should read packages/forge/README.md (Node 24), not root README (Node 22)",
  ).toBe("pass");
});

test("monorepo: SURFACE-03 scans packages/forge/ for .tgz, not monorepo root", async () => {
  await setupMonorepo(tempDir);
  // Place a .tgz at monorepo root — should NOT trigger SURFACE-03 fail
  await writeFile(join(tempDir, "root.tgz"), "fake", "utf8");
  const result = await runPublicSurfaceValidate({} as never, mockContext(tempDir));
  const checks = result.data?.checks ?? [];
  const surface03 = checks.find((c) => c.rule === "SURFACE-03");
  expect(
    surface03?.status,
    "Monorepo root .tgz should not affect SURFACE-03 — only packages/forge/ is scanned",
  ).toBe("pass");
});
