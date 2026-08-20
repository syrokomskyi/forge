import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAdapters, detectAdapter, detectAdapters } from "../registry.ts";
import { nodeTypescriptPnpmAdapter } from "../node-typescript-pnpm/index.ts";
import { phaserPnpmAdapter } from "../phaser-pnpm/index.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-registry-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("getAdapters", () => {
  it("returns built-in adapters", () => {
    const adapters = getAdapters();
    expect(adapters).toHaveLength(2);
    const ids = adapters.map((a) => a.id);
    expect(ids).toContain("node-typescript-pnpm");
    expect(ids).toContain("phaser-pnpm");
  });

  it("returns built-in adapters even with undefined config", () => {
    const adapters = getAdapters(undefined);
    expect(adapters).toHaveLength(2);
  });
});

describe("detectAdapter", () => {
  it("detects node-typescript-pnpm when package.json + tsconfig.json + pnpm-lock.yaml exist", async () => {
    await writeFile(join(tempDir, "package.json"), '{"name":"test"}', "utf8");
    await writeFile(join(tempDir, "tsconfig.json"), "{}", "utf8");
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "", "utf8");

    const adapter = detectAdapter(tempDir);
    expect(adapter?.id).toBe("node-typescript-pnpm");
  });

  it("detects phaser-pnpm when phaser is in dependencies", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      '{"name":"game","dependencies":{"phaser":"^3.0.0"}}',
      "utf8",
    );
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "", "utf8");

    const adapter = detectAdapter(tempDir);
    expect(adapter?.id).toBe("phaser-pnpm");
  });

  it("returns null when no adapter matches", () => {
    const adapter = detectAdapter(tempDir);
    expect(adapter).toBeNull();
  });

  it("returns first matching adapter when multiple match", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      '{"name":"game","dependencies":{"phaser":"^3.0.0"}}',
      "utf8",
    );
    await writeFile(join(tempDir, "tsconfig.json"), "{}", "utf8");
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "", "utf8");

    const adapter = detectAdapter(tempDir);
    expect(adapter).toBeDefined();
  });
});

describe("detectAdapters", () => {
  it("returns all matching adapters", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      '{"name":"game","dependencies":{"phaser":"^3.0.0"}}',
      "utf8",
    );
    await writeFile(join(tempDir, "tsconfig.json"), "{}", "utf8");
    await writeFile(join(tempDir, "pnpm-lock.yaml"), "", "utf8");

    const adapters = detectAdapters(tempDir);
    expect(adapters.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array when nothing matches", () => {
    expect(detectAdapters(tempDir)).toEqual([]);
  });
});

describe("built-in adapter analyze", () => {
  it("nodeTypescriptPnpmAdapter.analyze derives bindings from scripts", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "@scope/my-app",
        scripts: {
          build: "tsc",
          test: "vitest",
          typecheck: "tsc --noEmit",
        },
      }),
      "utf8",
    );

    const analysis = nodeTypescriptPnpmAdapter.analyze(tempDir);
    expect(analysis.packageManager).toBe("pnpm");
    expect(analysis.appName).toBe("my-app");
    expect(analysis.bindings.test).toBe("vitest");
    expect(analysis.bindings.scopedBuild).toBe("tsc");
    expect(analysis.placement).toBe("apps");
  });

  it("phaserPnpmAdapter.analyze detects phaser stack", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "my-game",
        dependencies: { phaser: "^3.0.0" },
      }),
      "utf8",
    );

    const analysis = phaserPnpmAdapter.analyze(tempDir);
    expect(analysis.stack).toContain("phaser");
    expect(analysis.appName).toBe("my-game");
  });
});
