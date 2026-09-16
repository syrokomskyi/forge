/*
<MODULE_CONTRACT>
<purpose>Behavioural tests for defineTsCheck — model built once per execute,
contract+rules preserved, --globs flag declared, empty-workspace pass,
error→fail/exitCode 1, warning→warn/exitCode 0 (RFC-1099).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1099: initial harness tests at the definition.execute() seam.</item>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KernelCommandInput,
  KernelLogger,
  KernelRuntimeContext,
  Diagnostic,
} from "@warpgogol/werkstatt-engine/kernel/types";
import { defineTsCheck, type TsCheckData } from "./run-ts-check.ts";
import { makeDiagnostic } from "./diagnostic-helpers.ts";

const noopLogger: KernelLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  event: () => {},
  getEvents: () => [],
};

function ctx(workspaceRoot: string): KernelRuntimeContext {
  return {
    workspaceRoot,
    siteExplicit: false,
    logger: noopLogger,
    dryRun: false,
    outputFormat: "json",
    io: undefined as never,
    actualState: undefined as never,
  };
}

const baseInput: KernelCommandInput = { argv: [], flags: {} };

async function run(
  def: ReturnType<typeof defineTsCheck>,
  workspaceRoot: string,
  input: KernelCommandInput = baseInput,
): Promise<{ status?: string; exitCode?: number; diagnostics: Diagnostic[]; summary?: string }> {
  const result = await def.execute(input, ctx(workspaceRoot));
  const data = result?.data as TsCheckData | undefined;
  return {
    status: data?.status,
    exitCode: result?.exitCode,
    diagnostics: data?.diagnostics ?? [],
    summary: result?.summary,
  };
}

let root: string;

function writePkg(dir: string, name: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ts-harness-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("defineTsCheck", () => {
  it("preserves contract and rules on the emitted definition (DNA-91)", () => {
    const def = defineTsCheck({
      name: "ts.example.validate",
      description: "example",
      reads: ["packages/**"],
      contract: "ts",
      rules: ["TS-EXAMPLE-01"],
      check: () => [],
    });
    expect(def.contract).toBe("ts");
    expect(def.rules).toEqual(["TS-EXAMPLE-01"]);
    expect(def.flags?.globs?.kind).toBe("string");
  });

  it("returns pass with a note on empty workspace (no packages matched)", async () => {
    const def = defineTsCheck({
      name: "ts.example.validate",
      description: "example",
      reads: [],
      contract: "ts",
      rules: [],
      check: () => [makeDiagnostic("TS-EXAMPLE-01", "error", "should not fire")],
    });
    const result = await run(def, root);
    expect(result.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("no workspace packages matched");
  });

  it("maps error diagnostics to fail + exitCode 1", async () => {
    writePkg("packages/a", "@pkg/a");
    const def = defineTsCheck({
      name: "ts.example.validate",
      description: "example",
      reads: [],
      contract: "ts",
      rules: ["TS-EXAMPLE-01"],
      check: (model) => {
        expect(model.packages).toHaveLength(1);
        return [makeDiagnostic("TS-EXAMPLE-01", "error", "boom")];
      },
    });
    const result = await run(def, root);
    expect(result.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics[0]?.ruleId).toBe("TS-EXAMPLE-01");
  });

  it("maps warning-only diagnostics to warn + exitCode 0", async () => {
    writePkg("packages/a", "@pkg/a");
    const def = defineTsCheck({
      name: "ts.example.validate",
      description: "example",
      reads: [],
      contract: "ts",
      rules: [],
      check: () => [makeDiagnostic("TS-EXAMPLE-01", "warning", "careful")],
    });
    const result = await run(def, root);
    expect(result.status).toBe("warn");
    expect(result.exitCode).toBe(0);
  });

  it("builds the model exactly once per execute call", async () => {
    writePkg("packages/a", "@pkg/a");
    let calls = 0;
    const def = defineTsCheck({
      name: "ts.example.validate",
      description: "example",
      reads: [],
      contract: "ts",
      rules: [],
      check: (model) => {
        calls++;
        expect(model.scannedFiles).toBeGreaterThanOrEqual(0);
        return [] as Diagnostic[];
      },
    });
    await def.execute(baseInput, ctx(root));
    expect(calls).toBe(1);
  });

  it("honours the --globs flag", async () => {
    writePkg("libs/x", "@lib/x");
    writePkg("packages/a", "@pkg/a");
    const seen: string[] = [];
    const def = defineTsCheck({
      name: "ts.example.validate",
      description: "example",
      reads: [],
      contract: "ts",
      rules: [],
      check: (model) => {
        seen.push(...model.packages.map((p) => p.dir));
        return [];
      },
    });
    await def.execute({ argv: [], flags: { globs: "libs/*" } }, ctx(root));
    expect(seen).toEqual(["libs/x"]);
  });
});
