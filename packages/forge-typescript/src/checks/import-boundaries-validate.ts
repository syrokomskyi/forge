/*
<MODULE_CONTRACT>
<purpose>ts.import.boundaries.validate — validates no packages-to-apps import boundary violations (TS-002, RFC-0889).</purpose>
<keywords>imports, boundaries, validate, typescript</keywords>
<non-goals>
  <item>Does not modify source files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial import boundaries validator.</item>
</CHANGE_SUMMARY>
*/

import type {
  KernelCommandDefinition,
  KernelCommandResult,
  Diagnostic,
} from "@warpgogol/werkstatt-engine/kernel/types";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { makeDiagnostic, emptySummary, buildSummary } from "./diagnostic-helpers.ts";

export interface ImportBoundariesValidateData {
  command: string;
  status: "pass" | "warn" | "fail";
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
}

const IMPORT_PATTERN = /^\s*import\s+.*?\s+from\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

async function scanTsFiles(
  dir: string,
  workspaceRoot: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      await scanTsFiles(fullPath, workspaceRoot, diagnostics);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      const relPath = relative(workspaceRoot, fullPath);
      if (
        relPath.includes("/__tests__/") ||
        relPath.endsWith(".test.ts") ||
        relPath.endsWith(".spec.ts")
      ) {
        continue;
      }

      let content: string;
      try {
        content = await readFile(fullPath, "utf8");
      } catch {
        continue;
      }

      const imports = new Set<string>();
      let match: RegExpExecArray | null;
      IMPORT_PATTERN.lastIndex = 0;
      while ((match = IMPORT_PATTERN.exec(content)) !== null) {
        imports.add(match[1]);
      }
      DYNAMIC_IMPORT_PATTERN.lastIndex = 0;
      while ((match = DYNAMIC_IMPORT_PATTERN.exec(content)) !== null) {
        imports.add(match[1]);
      }

      for (const importSpecifier of imports) {
        if (importSpecifier.startsWith("apps/") || importSpecifier.startsWith("../apps/")) {
          diagnostics.push(
            makeDiagnostic(
              "TS-IMPORT-01",
              "error",
              `Import boundary violation: packages must not import from apps. Found import of "${importSpecifier}".`,
              relPath,
            ),
          );
        }
        if (importSpecifier.includes("/missions/") || importSpecifier.startsWith("../missions/")) {
          diagnostics.push(
            makeDiagnostic(
              "TS-IMPORT-02",
              "error",
              `Import boundary violation: packages must not import from missions. Found import of "${importSpecifier}".`,
              relPath,
            ),
          );
        }
      }
    }
  }
}

export async function runImportBoundariesValidate(
  workspaceRoot: string,
): Promise<KernelCommandResult<ImportBoundariesValidateData>> {
  const diagnostics: Diagnostic[] = [];

  const packagesDir = join(workspaceRoot, "packages");
  try {
    await stat(packagesDir);
  } catch {
    return {
      data: {
        command: "ts.import.boundaries.validate",
        status: "pass",
        diagnostics: [],
        summary: emptySummary(),
      },
      exitCode: 0,
      summary: "ts.import.boundaries.validate: pass (no packages directory)",
    };
  }

  await scanTsFiles(packagesDir, workspaceRoot, diagnostics);

  const summary = buildSummary(diagnostics);
  const status = summary.error > 0 ? "fail" : "pass";

  return {
    data: { command: "ts.import.boundaries.validate", status, diagnostics, summary },
    exitCode: summary.error > 0 ? 1 : 0,
    summary: `ts.import.boundaries.validate: ${status} (${summary.error} error(s))`,
  };
}

export function createImportBoundariesValidateCommand(): KernelCommandDefinition<ImportBoundariesValidateData> {
  return {
    name: "ts.import.boundaries.validate",
    description:
      "Validate import boundaries: no packages-to-apps or packages-to-missions imports (TS-002).",
    scope: "workspace",
    cacheable: true,
    supportsAllSites: false,
    reads: ["packages/**/*.ts", "packages/**/*.tsx"],
    async execute(_input, context) {
      return runImportBoundariesValidate(context.workspaceRoot);
    },
  };
}
