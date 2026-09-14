/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.file-size.lint — SIZE-01 rule from RFC-1088.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1088: initial tests for portable file-size lint handler.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFileSizeLint, countLines } from "../../os/core/handlers/file-size-lint.ts";
import type { ForgeRuntimeContext, ForgeLogger } from "../types.ts";

const logger: ForgeLogger = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
};

function mockContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger,
    dryRun: false,
    outputFormat: "json",
  };
}

function input(flags: Record<string, unknown> = {}): { argv: string[]; flags: Record<string, unknown> } {
  return { argv: [], flags };
}

describe("countLines (RFC-1088)", () => {
  it("counts physical lines including a trailing newline", () => {
    expect(countLines("a\nb\nc\n")).toBe(4);
  });

  it("returns 0 for an empty source", () => {
    expect(countLines("")).toBe(0);
  });
});

describe("runFileSizeLint (RFC-1088, command-level)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "forge-file-size-lint-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("SIZE-01 (warning): flags a 700-line file as warning (601-1200 tier)", async () => {
    await mkdir(join(tempDir, "packages", "some-pkg", "src"), { recursive: true });
    const big = Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join("\n");
    await writeFile(join(tempDir, "packages", "some-pkg", "src", "big.ts"), big, "utf8");

    const result = await runFileSizeLint(input(), mockContext(tempDir));
    expect(result.exitCode ?? 0).toBe(0);

    const diagnostics = (
      result.data as { diagnostics: Array<{ ruleId: string; severity: string; file: string }> }
    ).diagnostics;
    const hit = diagnostics.find((d) => d.ruleId === "SIZE-01" && d.file.endsWith("big.ts"));
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("SIZE-01 (error): flags a 1300-line file as error (1200+ tier)", async () => {
    await mkdir(join(tempDir, "packages", "some-pkg", "src"), { recursive: true });
    const huge = Array.from({ length: 1300 }, (_, i) => `const x${i} = ${i};`).join("\n");
    await writeFile(join(tempDir, "packages", "some-pkg", "src", "huge.ts"), huge, "utf8");

    const result = await runFileSizeLint(input(), mockContext(tempDir));
    expect(result.exitCode).toBe(1);

    const diagnostics = (
      result.data as { diagnostics: Array<{ ruleId: string; severity: string; file: string }> }
    ).diagnostics;
    const hit = diagnostics.find((d) => d.ruleId === "SIZE-01" && d.file.endsWith("huge.ts"));
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });

  it("passes without diagnostics when every file is under the threshold", async () => {
    await mkdir(join(tempDir, "packages", "some-pkg", "src"), { recursive: true });
    await writeFile(
      join(tempDir, "packages", "some-pkg", "src", "small.ts"),
      "export const x = 1;\n",
      "utf8",
    );

    const result = await runFileSizeLint(input(), mockContext(tempDir));
    expect(result.exitCode ?? 0).toBe(0);

    const diagnostics = (result.data as { diagnostics: Array<{ ruleId: string }> }).diagnostics;
    expect(diagnostics.length).toBe(0);
  });

  it("--write-baseline writes a YAML baseline to workspace root", async () => {
    await mkdir(join(tempDir, "packages", "some-pkg", "src"), { recursive: true });
    const big = Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join("\n");
    await writeFile(join(tempDir, "packages", "some-pkg", "src", "big.ts"), big, "utf8");

    const result = await runFileSizeLint(
      input({ "write-baseline": true }),
      mockContext(tempDir),
    );
    expect(result.exitCode ?? 0).toBe(0);

    const baselineRaw = await readFile(
      join(tempDir, "file-size-lint.baseline.yaml"),
      "utf8",
    );
    expect(baselineRaw).toContain("schemaVersion");
    expect(baselineRaw).toContain("threshold: 600");
    expect(baselineRaw).toContain("big.ts");
  });

  it("baseline suppresses files within their ceiling", async () => {
    await mkdir(join(tempDir, "packages", "some-pkg", "src"), { recursive: true });
    const big = Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join("\n");
    await writeFile(join(tempDir, "packages", "some-pkg", "src", "big.ts"), big, "utf8");

    await writeFile(
      join(tempDir, "file-size-lint.baseline.yaml"),
      `meta:\n  schemaVersion: 1\n  threshold: 600\nceilings:\n  packages/some-pkg/src/big.ts: 700\n`,
      "utf8",
    );

    const result = await runFileSizeLint(input(), mockContext(tempDir));
    expect(result.exitCode ?? 0).toBe(0);

    const diagnostics = (result.data as { diagnostics: Array<{ ruleId: string }> }).diagnostics;
    expect(diagnostics.length).toBe(0);
  });

  it("baseline flags files that grew beyond their ceiling", async () => {
    await mkdir(join(tempDir, "packages", "some-pkg", "src"), { recursive: true });
    const big = Array.from({ length: 800 }, (_, i) => `const x${i} = ${i};`).join("\n");
    await writeFile(join(tempDir, "packages", "some-pkg", "src", "big.ts"), big, "utf8");

    await writeFile(
      join(tempDir, "file-size-lint.baseline.yaml"),
      `meta:\n  schemaVersion: 1\n  threshold: 600\nceilings:\n  packages/some-pkg/src/big.ts: 700\n`,
      "utf8",
    );

    const result = await runFileSizeLint(input(), mockContext(tempDir));
    expect(result.exitCode ?? 0).toBe(0);

    const diagnostics = (
      result.data as { diagnostics: Array<{ ruleId: string; message: string }> }
    ).diagnostics;
    const hit = diagnostics.find((d) => d.ruleId === "SIZE-01");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("grew from the baselined 700 to 800");
  });

  it("--baseline-path overrides the default baseline location", async () => {
    await mkdir(join(tempDir, "packages", "some-pkg", "src"), { recursive: true });
    const big = Array.from({ length: 700 }, (_, i) => `const x${i} = ${i};`).join("\n");
    await writeFile(join(tempDir, "packages", "some-pkg", "src", "big.ts"), big, "utf8");

    const customPath = "custom-baseline.yaml";
    const result = await runFileSizeLint(
      input({ "write-baseline": true, "baseline-path": customPath }),
      mockContext(tempDir),
    );
    expect(result.exitCode ?? 0).toBe(0);

    const baselineRaw = await readFile(join(tempDir, customPath), "utf8");
    expect(baselineRaw).toContain("big.ts");
  });
});
