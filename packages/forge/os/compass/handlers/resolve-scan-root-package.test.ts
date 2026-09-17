import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

function makeContext(workspaceRoot: string, siteExplicit = false): ForgeRuntimeContext {
  return {
    workspaceRoot,
    site: undefined,
    siteExplicit,
    dryRun: false,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { flags } as ForgeCommandInput;
}

describe("resolveCompassScanRoot --package", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compass-package-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("implies --packages scope: resolves to packages/<name>/src when src exists", () => {
    mkdirSync(join(tempDir, "packages", "my-pkg", "src"), { recursive: true });
    const result = resolveCompassScanRoot(makeInput({ package: "my-pkg" }), makeContext(tempDir));
    expect(result).toBe(join(tempDir, "packages", "my-pkg", "src"));
  });

  it("implies --packages scope: resolves to packages/<name> when no src dir", () => {
    mkdirSync(join(tempDir, "packages", "my-pkg"), { recursive: true });
    const result = resolveCompassScanRoot(makeInput({ package: "my-pkg" }), makeContext(tempDir));
    expect(result).toBe(join(tempDir, "packages", "my-pkg"));
  });

  it("resolves packages/os/<name> candidates first", () => {
    mkdirSync(join(tempDir, "packages", "os", "my-pkg"), { recursive: true });
    const result = resolveCompassScanRoot(makeInput({ package: "my-pkg" }), makeContext(tempDir));
    expect(result).toBe(join(tempDir, "packages", "os", "my-pkg"));
  });

  it("throws when --package and --workpiece are both set", () => {
    expect(() =>
      resolveCompassScanRoot(
        makeInput({ package: "my-pkg", workpiece: "some/path" }),
        makeContext(tempDir),
      ),
    ).toThrow("--workpiece and --packages are mutually exclusive");
  });

  it("throws when --package and --site are both set", () => {
    expect(() =>
      resolveCompassScanRoot(makeInput({ package: "my-pkg" }), makeContext(tempDir, true)),
    ).toThrow("--site and --packages are mutually exclusive");
  });

  it("throws when the package does not exist", () => {
    expect(() =>
      resolveCompassScanRoot(makeInput({ package: "nonexistent" }), makeContext(tempDir)),
    ).toThrow('Package "nonexistent" not found');
  });

  it("--packages without --package still scans the packages/ root", () => {
    const result = resolveCompassScanRoot(makeInput({ packages: true }), makeContext(tempDir));
    expect(result).toBe(join(tempDir, "packages"));
  });
});
