/*
<MODULE_CONTRACT>
<purpose>Unit tests for workspace discovery and type auto-detection (RFC-0611).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0611: initial workspace discovery tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaces, detectWorkspaceType } from "../onboarding/workspace-discovery.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ws-discovery-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("detectWorkspaceType returns null for directory without package.json", () => {
  expect(detectWorkspaceType(tempDir)).toBeNull();
});

test("detectWorkspaceType returns package for directory with only package.json", async () => {
  await writeFile(join(tempDir, "package.json"), "{}");
  expect(detectWorkspaceType(tempDir)).toBe("package");
});

test("detectWorkspaceType returns app for directory with astro.config.mjs", async () => {
  await writeFile(join(tempDir, "package.json"), "{}");
  await writeFile(join(tempDir, "astro.config.mjs"), "export default {}");
  expect(detectWorkspaceType(tempDir)).toBe("app");
});

test("detectWorkspaceType returns app for directory with astro.config.ts", async () => {
  await writeFile(join(tempDir, "package.json"), "{}");
  await writeFile(join(tempDir, "astro.config.ts"), "export default {}");
  expect(detectWorkspaceType(tempDir)).toBe("app");
});

test("detectWorkspaceType returns service for directory with Dockerfile", async () => {
  await writeFile(join(tempDir, "package.json"), "{}");
  await writeFile(join(tempDir, "Dockerfile"), "FROM node:20");
  expect(detectWorkspaceType(tempDir)).toBe("service");
});

test("detectWorkspaceType returns service for directory with service.config.yaml", async () => {
  await writeFile(join(tempDir, "package.json"), "{}");
  await writeFile(join(tempDir, "service.config.yaml"), "name: test");
  expect(detectWorkspaceType(tempDir)).toBe("service");
});

test("detectWorkspaceType app takes precedence over service", async () => {
  await writeFile(join(tempDir, "package.json"), "{}");
  await writeFile(join(tempDir, "astro.config.mjs"), "export default {}");
  await writeFile(join(tempDir, "Dockerfile"), "FROM node:20");
  expect(detectWorkspaceType(tempDir)).toBe("app");
});

test("discoverWorkspaces finds nested workspace directories", async () => {
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(join(tempDir, "packages", "my-pkg", "package.json"), "{}");

  await mkdir(join(tempDir, "apps", "my-app"), { recursive: true });
  await writeFile(join(tempDir, "apps", "my-app", "package.json"), "{}");
  await writeFile(join(tempDir, "apps", "my-app", "astro.config.mjs"), "export default {}");

  await mkdir(join(tempDir, "services", "my-svc"), { recursive: true });
  await writeFile(join(tempDir, "services", "my-svc", "package.json"), "{}");
  await writeFile(join(tempDir, "services", "my-svc", "Dockerfile"), "FROM node:20");

  const workspaces = discoverWorkspaces(tempDir);

  expect(workspaces).toHaveLength(3);
  const paths = workspaces.map((w) => w.path);
  expect(paths).toContain("packages/my-pkg");
  expect(paths).toContain("apps/my-app");
  expect(paths).toContain("services/my-svc");

  const pkg = workspaces.find((w) => w.path === "packages/my-pkg");
  expect(pkg?.type).toBe("package");
  expect(pkg?.hasAgentsMd).toBe(false);

  const app = workspaces.find((w) => w.path === "apps/my-app");
  expect(app?.type).toBe("app");

  const svc = workspaces.find((w) => w.path === "services/my-svc");
  expect(svc?.type).toBe("service");
});

test("discoverWorkspaces skips node_modules, .git, dist, .turbo, .cache, .agents", async () => {
  for (const skip of ["node_modules", ".git", "dist", ".turbo", ".cache", ".agents"]) {
    await mkdir(join(tempDir, skip, "sub"), { recursive: true });
    await writeFile(join(tempDir, skip, "sub", "package.json"), "{}");
  }

  const workspaces = discoverWorkspaces(tempDir);
  expect(workspaces).toHaveLength(0);
});

test("discoverWorkspaces detects generated AGENTS.md", async () => {
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(join(tempDir, "packages", "my-pkg", "package.json"), "{}");
  await writeFile(
    join(tempDir, "packages", "my-pkg", "AGENTS.md"),
    "<!--\n  GENERATED. Do not change this line unless the file contains project specific changes.\n-->\n# Agent Guide\n",
  );

  const workspaces = discoverWorkspaces(tempDir);
  expect(workspaces).toHaveLength(1);
  expect(workspaces[0].hasAgentsMd).toBe(true);
  expect(workspaces[0].isGenerated).toBe(true);
});

test("discoverWorkspaces detects hand-written AGENTS.md", async () => {
  await mkdir(join(tempDir, "packages", "my-pkg"), { recursive: true });
  await writeFile(join(tempDir, "packages", "my-pkg", "package.json"), "{}");
  await writeFile(join(tempDir, "packages", "my-pkg", "AGENTS.md"), "# My custom guide\n");

  const workspaces = discoverWorkspaces(tempDir);
  expect(workspaces).toHaveLength(1);
  expect(workspaces[0].hasAgentsMd).toBe(true);
  expect(workspaces[0].isGenerated).toBe(false);
});

test("discoverWorkspaces returns empty for project with no workspaces", () => {
  const workspaces = discoverWorkspaces(tempDir);
  expect(workspaces).toHaveLength(0);
});
