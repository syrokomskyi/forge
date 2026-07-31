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

describe("resolveCompassScanRoot --workpiece (RFC-0617)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compass-workpiece-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns the resolved workpiece path when --workpiece is set", () => {
    const relPath = "missions/test-mission/workpiece";
    mkdirSync(join(tempDir, relPath), { recursive: true });
    const result = resolveCompassScanRoot(makeInput({ workpiece: relPath }), makeContext(tempDir));
    expect(result).toBe(join(tempDir, relPath));
  });

  it("throws when --workpiece and --packages are both set", () => {
    expect(() =>
      resolveCompassScanRoot(
        makeInput({ workpiece: "some/path", packages: true }),
        makeContext(tempDir),
      ),
    ).toThrow("--workpiece and --packages are mutually exclusive");
  });

  it("throws when --workpiece and --site are both set", () => {
    expect(() =>
      resolveCompassScanRoot(makeInput({ workpiece: "some/path" }), makeContext(tempDir, true)),
    ).toThrow("--workpiece and --site are mutually exclusive");
  });

  it("throws when workpiece path does not exist", () => {
    expect(() =>
      resolveCompassScanRoot(makeInput({ workpiece: "nonexistent/path" }), makeContext(tempDir)),
    ).toThrow("workpiece path not found");
  });

  it("ignores --workpiece when not set and falls through to site resolution", () => {
    const result = resolveCompassScanRoot(makeInput({}), makeContext(tempDir));
    expect(result).toBeUndefined();
  });
});
