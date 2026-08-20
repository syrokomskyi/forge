import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectWorkspaceType, discoverWorkspaces } from "../workspace-discovery.ts";
import { GENERATED_MARKER } from "../../utils/index.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-ws-discovery-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("detectWorkspaceType", () => {
  it("returns null when no package.json exists", () => {
    expect(detectWorkspaceType(tempDir)).toBeNull();
  });

  it("detects 'app' when astro.config.mjs exists", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"app"}', "utf8");
    await writeFile(join(tempDir, "astro.config.mjs"), "export default {}", "utf8");
    expect(detectWorkspaceType(tempDir)).toBe("app");
  });

  it("detects 'app' when astro.config.ts exists", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"app"}', "utf8");
    await writeFile(join(tempDir, "astro.config.ts"), "export default {}", "utf8");
    expect(detectWorkspaceType(tempDir)).toBe("app");
  });

  it("detects 'service' when Dockerfile exists", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"svc"}', "utf8");
    await writeFile(join(tempDir, "Dockerfile"), "FROM node:20", "utf8");
    expect(detectWorkspaceType(tempDir)).toBe("service");
  });

  it("detects 'service' when service.config.yaml exists", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"svc"}', "utf8");
    await writeFile(join(tempDir, "service.config.yaml"), "name: svc", "utf8");
    expect(detectWorkspaceType(tempDir)).toBe("service");
  });

  it("defaults to 'package' when package.json exists but no markers", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"pkg"}', "utf8");
    expect(detectWorkspaceType(tempDir)).toBe("package");
  });

  it("uses profile workspaceTypes when provided", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"pkg","dependencies":{"phaser":"^3"}}', "utf8");
    const wst = [{ id: "game", detect: { packageJsonDep: "phaser" }, skills: [] }];
    expect(detectWorkspaceType(tempDir, wst)).toBe("game");
  });

  it("returns null when profile workspaceTypes provided but no match", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"pkg"}', "utf8");
    const wst = [{ id: "game", detect: { packageJsonDep: "phaser" }, skills: [] }];
    expect(detectWorkspaceType(tempDir, wst)).toBeNull();
  });

  it("profile workspaceTypes with glob detection", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"pkg"}', "utf8");
    await writeFile(join(tempDir, "game.config"), "config", "utf8");
    const wst = [{ id: "game", detect: { glob: "game.*" }, skills: [] }];
    expect(detectWorkspaceType(tempDir, wst)).toBe("game");
  });

  it("profile workspaceTypes with contains detection", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"pkg"}', "utf8");
    await writeFile(join(tempDir, "marker.txt"), "marker", "utf8");
    const wst = [{ id: "custom", detect: { contains: "marker.txt" }, skills: [] }];
    expect(detectWorkspaceType(tempDir, wst)).toBe("custom");
  });
});

describe("discoverWorkspaces", () => {
  it("returns empty for directory with no workspaces", () => {
    expect(discoverWorkspaces(tempDir)).toEqual([]);
  });

  it("discovers nested workspaces", async () => {
    const appsDir = join(tempDir, "apps");
    const appDir = join(appsDir, "my-app");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "package.json"), '{"name":"my-app"}', "utf8");
    await writeFile(join(appDir, "astro.config.mjs"), "export default {}", "utf8");

    const results = discoverWorkspaces(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("app");
    expect(results[0].path).toContain("my-app");
  });

  it("skips node_modules, .git, dist, .turbo, .cache, .agents", async () => {
    for (const skipDir of ["node_modules", ".git", "dist", ".turbo", ".cache", ".agents"]) {
      const dir = join(tempDir, skipDir, "sub");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), '{"name":"skip"}', "utf8");
    }

    const results = discoverWorkspaces(tempDir);
    expect(results).toHaveLength(0);
  });

  it("detects hasAgentsMd and isGenerated", async () => {
    const pkgDir = join(tempDir, "packages", "my-pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), '{"name":"my-pkg"}', "utf8");
    await writeFile(
      join(pkgDir, "AGENTS.md"),
      `<!-- ${GENERATED_MARKER} -->\n# Test`,
      "utf8",
    );

    const results = discoverWorkspaces(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].hasAgentsMd).toBe(true);
    expect(results[0].isGenerated).toBe(true);
  });

  it("reports hasAgentsMd=false when no AGENTS.md", async () => {
    const pkgDir = join(tempDir, "packages", "my-pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), '{"name":"my-pkg"}', "utf8");

    const results = discoverWorkspaces(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].hasAgentsMd).toBe(false);
    expect(results[0].isGenerated).toBe(false);
  });
});
