/*
<MODULE_CONTRACT>
<purpose>ts.tsconfig.validate — validates tsconfig.base.json and per-package tsconfig.json consistency (TS-001, RFC-0889).</purpose>
<keywords>tsconfig, validate, strict, typescript</keywords>
<non-goals>
  <item>Does not modify tsconfig files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial tsconfig validator.</item>
</CHANGE_SUMMARY>
*/

import type {
  KernelCommandDefinition,
  KernelCommandResult,
  Diagnostic,
} from "@warpgogol/werkstatt-engine/kernel/types";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { makeDiagnostic, emptySummary, buildSummary } from "./diagnostic-helpers.ts";

export interface TsconfigValidateData {
  command: string;
  status: "pass" | "warn" | "fail";
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
}

export async function runTsconfigValidate(
  workspaceRoot: string,
): Promise<KernelCommandResult<TsconfigValidateData>> {
  const diagnostics: Diagnostic[] = [];
  const basePath = join(workspaceRoot, "tsconfig.base.json");

  let baseConfig: Record<string, unknown> | null = null;

  // Check if workspace is truly empty (no tsconfig.base.json AND no packages directory)
  let hasPackagesDir = false;
  try {
    const packagesDir = join(workspaceRoot, "packages");
    const entries = await readdir(packagesDir);
    hasPackagesDir = entries.length > 0;
  } catch {
    // No packages directory
  }

  try {
    const baseContent = await readFile(basePath, "utf8");
    baseConfig = JSON.parse(baseContent) as Record<string, unknown>;
  } catch {
    if (!hasPackagesDir) {
      // Truly empty workspace — nothing to validate
      return {
        data: {
          command: "ts.tsconfig.validate",
          status: "pass",
          diagnostics: [],
          summary: emptySummary(),
        },
        exitCode: 0,
        summary: "ts.tsconfig.validate: pass (empty workspace)",
      };
    }
    diagnostics.push(
      makeDiagnostic(
        "TS-TSCONFIG-01",
        "error",
        "tsconfig.base.json not found at workspace root. All workspace packages must extend a shared base config.",
        "tsconfig.base.json",
      ),
    );
    const summary = buildSummary(diagnostics);
    return {
      data: { command: "ts.tsconfig.validate", status: "fail", diagnostics, summary },
      exitCode: 1,
      summary: `ts.tsconfig.validate: ${summary.error} error(s)`,
    };
  }

  const baseCompilerOptions = (baseConfig?.compilerOptions ?? {}) as Record<string, unknown>;

  if (baseCompilerOptions.strict !== true) {
    diagnostics.push(
      makeDiagnostic(
        "TS-TSCONFIG-02",
        "error",
        'tsconfig.base.json must have "strict": true in compilerOptions.',
        "tsconfig.base.json",
      ),
    );
  }

  const expectedModuleResolution = baseCompilerOptions.moduleResolution;
  const expectedTarget = baseCompilerOptions.target;

  const tsconfigPaths: string[] = [];
  try {
    const packagesDir = join(workspaceRoot, "packages");
    const entries = await readdir(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const tsconfigPath = join(packagesDir, entry.name, "tsconfig.json");
        try {
          await readFile(tsconfigPath, "utf8");
          tsconfigPaths.push(tsconfigPath);
        } catch {
          // No tsconfig.json in this package — skip
        }
      }
    }
  } catch {
    // No packages directory — empty workspace
  }

  if (tsconfigPaths.length === 0 && diagnostics.length === 0) {
    return {
      data: {
        command: "ts.tsconfig.validate",
        status: "pass",
        diagnostics: [],
        summary: emptySummary(),
      },
      exitCode: 0,
      summary: "ts.tsconfig.validate: pass (no per-package tsconfig files found)",
    };
  }

  for (const tsconfigPath of tsconfigPaths) {
    const relPath = tsconfigPath.replace(workspaceRoot + "/", "");
    try {
      const content = await readFile(tsconfigPath, "utf8");
      const config = JSON.parse(content) as Record<string, unknown>;
      const compilerOptions = (config?.compilerOptions ?? {}) as Record<string, unknown>;

      if (expectedModuleResolution && compilerOptions.moduleResolution !== undefined) {
        if (compilerOptions.moduleResolution !== expectedModuleResolution) {
          diagnostics.push(
            makeDiagnostic(
              "TS-TSCONFIG-03",
              "error",
              `moduleResolution mismatch: expected "${expectedModuleResolution}", got "${compilerOptions.moduleResolution}".`,
              relPath,
            ),
          );
        }
      }

      if (expectedTarget && compilerOptions.target !== undefined) {
        if (compilerOptions.target !== expectedTarget) {
          diagnostics.push(
            makeDiagnostic(
              "TS-TSCONFIG-04",
              "error",
              `target mismatch: expected "${expectedTarget}", got "${compilerOptions.target}".`,
              relPath,
            ),
          );
        }
      }
    } catch {
      diagnostics.push(
        makeDiagnostic(
          "TS-TSCONFIG-05",
          "error",
          "Failed to read or parse tsconfig.json.",
          relPath,
        ),
      );
    }
  }

  const summary = buildSummary(diagnostics);
  const status = summary.error > 0 ? "fail" : "pass";

  return {
    data: { command: "ts.tsconfig.validate", status, diagnostics, summary },
    exitCode: summary.error > 0 ? 1 : 0,
    summary: `ts.tsconfig.validate: ${status} (${summary.error} error(s), ${summary.warning} warning(s))`,
  };
}

export function createTsconfigValidateCommand(): KernelCommandDefinition<TsconfigValidateData> {
  return {
    name: "ts.tsconfig.validate",
    contract: "ts",
    rules: [],
    description:
      "Validate tsconfig.base.json and per-package tsconfig.json consistency: strict mode, moduleResolution, target (TS-001).",
    scope: "workspace",
    cacheable: true,
    supportsAllSites: false,
    reads: ["tsconfig.base.json", "packages/*/tsconfig.json"],
    async execute(_input, context) {
      return runTsconfigValidate(context.workspaceRoot);
    },
  };
}
