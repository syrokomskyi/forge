/*
<MODULE_CONTRACT>
<purpose>Unit tests for profile-driven workspace detection (RFC-0640).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0640: initial profile-driven workspace detection tests.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaces, detectWorkspaceType } from "../onboarding/workspace-discovery.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ws-domain-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("detectWorkspaceType uses profile workspaceTypes when provided", async () => {
  await mkdir(join(tempDir, "scene-dir"), { recursive: true });
  await writeFile(join(tempDir, "scene-dir", "package.json"), "{}");
  await writeFile(join(tempDir, "scene-dir", "scene.scene"), "{}");

  const workspaceTypes: ProfileWorkspaceType[] = [
    {
      id: "scene",
      detect: { glob: "*.scene" },
    },
  ];

  expect(detectWorkspaceType(join(tempDir, "scene-dir"), workspaceTypes)).toBe("scene");
});

test("detectWorkspaceType returns null when workspaceTypes provided but no match", async () => {
  await mkdir(join(tempDir, "pkg-dir"), { recursive: true });
  await writeFile(join(tempDir, "pkg-dir", "package.json"), "{}");

  const workspaceTypes: ProfileWorkspaceType[] = [
    {
      id: "scene",
      detect: { glob: "*.scene" },
    },
  ];

  expect(detectWorkspaceType(join(tempDir, "pkg-dir"), workspaceTypes)).toBeNull();
});

test("detectWorkspaceType uses hardcoded detection when workspaceTypes absent", async () => {
  await mkdir(join(tempDir, "app-dir"), { recursive: true });
  await writeFile(join(tempDir, "app-dir", "package.json"), "{}");
  await writeFile(join(tempDir, "app-dir", "astro.config.mjs"), "export default {}");

  expect(detectWorkspaceType(join(tempDir, "app-dir"))).toBe("app");
});

test("detectWorkspaceType profile contains marker detection", async () => {
  await mkdir(join(tempDir, "video-dir"), { recursive: true });
  await writeFile(join(tempDir, "video-dir", "package.json"), "{}");
  await writeFile(join(tempDir, "video-dir", "video.config.yaml"), "test");

  const workspaceTypes: ProfileWorkspaceType[] = [
    {
      id: "video",
      detect: { contains: "video.config.yaml" },
    },
  ];

  expect(detectWorkspaceType(join(tempDir, "video-dir"), workspaceTypes)).toBe("video");
});

test("detectWorkspaceType profile packageJsonDep detection", async () => {
  await mkdir(join(tempDir, "phaser-dir"), { recursive: true });
  await writeFile(
    join(tempDir, "phaser-dir", "package.json"),
    JSON.stringify({ dependencies: { phaser: "^3.0.0" } }),
  );

  const workspaceTypes: ProfileWorkspaceType[] = [
    {
      id: "game",
      detect: { packageJsonDep: "phaser" },
    },
  ];

  expect(detectWorkspaceType(join(tempDir, "phaser-dir"), workspaceTypes)).toBe("game");
});

test("discoverWorkspaces passes workspaceTypes through to detection", async () => {
  await mkdir(join(tempDir, "packages", "scene-pkg"), { recursive: true });
  await writeFile(join(tempDir, "packages", "scene-pkg", "package.json"), "{}");
  await writeFile(join(tempDir, "packages", "scene-pkg", "scene.scene"), "{}");

  const workspaceTypes: ProfileWorkspaceType[] = [
    {
      id: "scene",
      detect: { glob: "*.scene" },
    },
  ];

  const results = discoverWorkspaces(tempDir, workspaceTypes);
  const sceneWs = results.find((w) => w.path === "packages/scene-pkg");
  expect(sceneWs).toBeDefined();
  expect(sceneWs?.type).toBe("scene");
});
