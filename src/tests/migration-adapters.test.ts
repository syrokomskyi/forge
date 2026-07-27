/*
<MODULE_CONTRACT>
<purpose>Unit tests for migration-adapter module — adapter detect/analyze/migrate, registry discovery, forge-protected file enforcement (RFC-0546).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0546: initial migration-adapter tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nodeTypescriptPnpmAdapter,
  phaserPnpmAdapter,
  getAdapters,
  detectAdapter,
  detectAdapters,
  FORGE_PROTECTED_PATHS,
  DEFAULT_EXCLUDE_PATTERNS,
} from "../migration-adapters/index.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-migration-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("FORGE_PROTECTED_PATHS includes forge.yaml, .agents, docs/rfcs, docs/adrs, PREFERENCES.md", () => {
  expect(FORGE_PROTECTED_PATHS).toContain("forge.yaml");
  expect(FORGE_PROTECTED_PATHS).toContain(".agents");
  expect(FORGE_PROTECTED_PATHS).toContain("docs/rfcs");
  expect(FORGE_PROTECTED_PATHS).toContain("docs/adrs");
  expect(FORGE_PROTECTED_PATHS).toContain("PREFERENCES.md");
});

test("DEFAULT_EXCLUDE_PATTERNS includes node_modules, dist, .next, .cache, .turbo but NOT .git", () => {
  expect(DEFAULT_EXCLUDE_PATTERNS).toContain("node_modules");
  expect(DEFAULT_EXCLUDE_PATTERNS).toContain("dist");
  expect(DEFAULT_EXCLUDE_PATTERNS).toContain(".next");
  expect(DEFAULT_EXCLUDE_PATTERNS).toContain(".cache");
  expect(DEFAULT_EXCLUDE_PATTERNS).toContain(".turbo");
  expect(DEFAULT_EXCLUDE_PATTERNS).not.toContain(".git");
});

test("node-typescript-pnpm adapter detects Node+TS+pnpm project", async () => {
  const sourceDir = join(tempDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test-app" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  expect(nodeTypescriptPnpmAdapter.detect(sourceDir)).toBe(true);
});

test("node-typescript-pnpm adapter does not detect project without pnpm lockfile", async () => {
  const sourceDir = join(tempDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test-app" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");

  expect(nodeTypescriptPnpmAdapter.detect(sourceDir)).toBe(false);
});

test("node-typescript-pnpm adapter analyzes package.json and derives bindings", async () => {
  const sourceDir = join(tempDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, "package.json"),
    JSON.stringify({
      name: "@org/my-app",
      scripts: {
        "build:check": "tsc --noEmit",
        test: "vitest",
        build: "turbo run build",
      },
    }),
  );
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  const analysis = nodeTypescriptPnpmAdapter.analyze(sourceDir);
  expect(analysis.stack).toContain("typescript");
  expect(analysis.packageManager).toBe("pnpm");
  expect(analysis.bindings.typecheck).toBe("tsc --noEmit");
  expect(analysis.bindings.test).toBe("vitest");
  expect(analysis.bindings.scopedBuild).toBe("turbo run build");
  expect(analysis.placement).toBe("apps");
  expect(analysis.appName).toBe("my-app");
});

test("node-typescript-pnpm adapter derives appName from directory when package.json name is absent", async () => {
  const sourceDir = join(tempDir, "MyCoolApp");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), "{}");
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  const analysis = nodeTypescriptPnpmAdapter.analyze(sourceDir);
  expect(analysis.appName).toBe("mycoolapp");
});

test("phaser-pnpm adapter detects project with phaser dependency", async () => {
  const sourceDir = join(tempDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, "package.json"),
    JSON.stringify({
      name: "phaser-game",
      dependencies: { phaser: "^3.80.0" },
    }),
  );

  expect(phaserPnpmAdapter.detect(sourceDir)).toBe(true);
});

test("phaser-pnpm adapter does not detect project without phaser dependency", async () => {
  const sourceDir = join(tempDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "regular-app" }));

  expect(phaserPnpmAdapter.detect(sourceDir)).toBe(false);
});

test("registry getAdapters returns both built-in adapters", () => {
  const adapters = getAdapters();
  expect(adapters).toHaveLength(2);
  expect(adapters.map((a) => a.id)).toContain("node-typescript-pnpm");
  expect(adapters.map((a) => a.id)).toContain("phaser-pnpm");
});

test("registry detectAdapter returns matching adapter for Node+TS+pnpm source", async () => {
  const sourceDir = join(tempDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  const adapter = detectAdapter(sourceDir);
  expect(adapter).not.toBeNull();
  expect(adapter?.id).toBe("node-typescript-pnpm");
});

test("registry detectAdapter returns null for unrecognized source", async () => {
  const sourceDir = join(tempDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "README.md"), "not a project");

  const adapter = detectAdapter(sourceDir);
  expect(adapter).toBeNull();
});

test("registry detectAdapters returns all matching adapters", async () => {
  const sourceDir = join(tempDir, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, "package.json"),
    JSON.stringify({
      name: "phaser-ts-app",
      dependencies: { phaser: "^3.80.0" },
      scripts: { "build:check": "tsc --noEmit" },
    }),
  );
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  const matches = detectAdapters(sourceDir);
  expect(matches.length).toBeGreaterThanOrEqual(1);
  expect(matches.map((a) => a.id)).toContain("phaser-pnpm");
});

test("migrate copies source files to apps/<appName>/ and excludes node_modules", async () => {
  const sourceDir = join(tempDir, "source");
  const targetDir = join(tempDir, "target");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await mkdir(join(sourceDir, "node_modules"), { recursive: true });
  await mkdir(join(sourceDir, "src"), { recursive: true });

  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test-app" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");
  await writeFile(join(sourceDir, "src", "index.ts"), "console.log('hello');");
  await writeFile(join(sourceDir, "node_modules", "evil.js"), "malware");

  const analysis = nodeTypescriptPnpmAdapter.analyze(sourceDir);
  const result = nodeTypescriptPnpmAdapter.migrate(sourceDir, targetDir, analysis);

  expect(result.filesCopied).toContain("package.json");
  expect(result.filesCopied).toContain("tsconfig.json");
  expect(result.filesCopied).toContain("src/index.ts");
  expect(result.filesCopied).not.toContain("node_modules/evil.js");

  const appDir = join(targetDir, "apps", "test-app");
  expect(existsSync(join(appDir, "package.json"))).toBe(true);
  expect(existsSync(join(appDir, "src", "index.ts"))).toBe(true);
  expect(existsSync(join(appDir, "node_modules", "evil.js"))).toBe(false);
});

test("migrate skips forge-protected files", async () => {
  const sourceDir = join(tempDir, "source");
  const targetDir = join(tempDir, "target");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await mkdir(join(sourceDir, "docs", "rfcs"), { recursive: true });

  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test-app" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");
  await writeFile(join(sourceDir, "forge.yaml"), "schema: forge/config@1");
  await writeFile(join(sourceDir, "PREFERENCES.md"), "# prefs");
  await writeFile(join(sourceDir, "docs", "rfcs", "rfc-0001.md"), "# RFC");

  const analysis = nodeTypescriptPnpmAdapter.analyze(sourceDir);
  const result = nodeTypescriptPnpmAdapter.migrate(sourceDir, targetDir, analysis);

  expect(result.filesSkipped).toContain("forge.yaml");
  expect(result.filesSkipped).toContain("PREFERENCES.md");
  expect(result.filesSkipped).toContain("docs/rfcs/rfc-0001.md");

  const appDir = join(targetDir, "apps", "test-app");
  expect(existsSync(join(appDir, "forge.yaml"))).toBe(false);
  expect(existsSync(join(appDir, "PREFERENCES.md"))).toBe(false);
  expect(existsSync(join(appDir, "docs", "rfcs", "rfc-0001.md"))).toBe(false);
});

test("postSetup runs git init when analysis.gitHistory is false", async () => {
  const sourceDir = join(tempDir, "source");
  const targetDir = join(tempDir, "target");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test-app" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  const analysis = nodeTypescriptPnpmAdapter.analyze(sourceDir);
  nodeTypescriptPnpmAdapter.postSetup(sourceDir, targetDir, analysis);

  expect(existsSync(join(targetDir, ".git"))).toBe(true);
});

test("postSetup runs git init when source has no .git", async () => {
  const sourceDir = join(tempDir, "source");
  const targetDir = join(tempDir, "target");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test-app" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  const analysis = nodeTypescriptPnpmAdapter.analyze(sourceDir);
  expect(analysis.gitHistory).toBe(false);
  nodeTypescriptPnpmAdapter.postSetup(sourceDir, targetDir, analysis);

  expect(existsSync(join(targetDir, ".git"))).toBe(true);
});

test("postSetup transfers git history via format-patch + git am when source has commits", async () => {
  const sourceDir = join(tempDir, "source");
  const targetDir = join(tempDir, "target");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test-app" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: sourceDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: sourceDir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: sourceDir, stdio: "pipe" });
  await writeFile(join(sourceDir, "README.md"), "hello");
  execSync("git add . && git commit -m 'initial'", { cwd: sourceDir, stdio: "pipe" });

  const analysis = nodeTypescriptPnpmAdapter.analyze(sourceDir);
  expect(analysis.gitHistory).toBe(true);
  nodeTypescriptPnpmAdapter.postSetup(sourceDir, targetDir, analysis);

  expect(existsSync(join(targetDir, ".git"))).toBe(true);
  const logResult = execSync("git log --oneline", { cwd: targetDir, stdio: "pipe" }).toString();
  expect(logResult).toContain("initial");
});

test("postSetup falls back to git init when source .git is empty (no commits)", async () => {
  const sourceDir = join(tempDir, "source");
  const targetDir = join(tempDir, "target");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(sourceDir, "package.json"), JSON.stringify({ name: "test-app" }));
  await writeFile(join(sourceDir, "tsconfig.json"), "{}");
  await writeFile(join(sourceDir, "pnpm-lock.yaml"), "");

  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: sourceDir, stdio: "pipe" });

  const analysis = nodeTypescriptPnpmAdapter.analyze(sourceDir);
  expect(analysis.gitHistory).toBe(true);
  nodeTypescriptPnpmAdapter.postSetup(sourceDir, targetDir, analysis);

  expect(existsSync(join(targetDir, ".git"))).toBe(true);
});
