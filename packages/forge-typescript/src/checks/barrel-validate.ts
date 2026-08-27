/*
<MODULE_CONTRACT>
<purpose>ts.barrel.validate — validates barrel exports (index.ts) do not re-export Node-only modules without subpath exports (TS-006, RFC-0889).</purpose>
<keywords>barrel, exports, validate, node-only, typescript</keywords>
<non-goals>
  <item>Does not modify barrel files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial barrel validator.</item>
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

export interface BarrelValidateData {
  command: string;
  status: "pass" | "warn" | "fail";
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
}

const NODE_ONLY_PATTERN = /from\s+["'](node:[^"']+)["']/g;
const RE_EXPORT_PATTERN = /export\s+(?:\*|\{[^}]+\})\s+from\s+["']([^"']+)["']/g;

async function scanBarrelFiles(
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
      await scanBarrelFiles(fullPath, workspaceRoot, diagnostics);
    } else if (entry === "index.ts" || entry === "index.tsx") {
      const relPath = relative(workspaceRoot, fullPath);
      if (relPath.includes("/__tests__/")) continue;

      let content: string;
      try {
        content = await readFile(fullPath, "utf8");
      } catch {
        continue;
      }

      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        const nodeOnlyMatch = NODE_ONLY_PATTERN.exec(line);
        if (nodeOnlyMatch) {
          diagnostics.push(
            makeDiagnostic(
              "TS-BARREL-01",
              "warning",
              `Barrel file re-exports Node-only module "${nodeOnlyMatch[1]}". Use a subpath export for client-side isolation.`,
              relPath,
              lineNumber,
            ),
          );
        }
        NODE_ONLY_PATTERN.lastIndex = 0;

        const reExportMatch = RE_EXPORT_PATTERN.exec(line);
        if (reExportMatch) {
          const importSpecifier = reExportMatch[1];
          if (importSpecifier.startsWith("node:")) {
            diagnostics.push(
              makeDiagnostic(
                "TS-BARREL-02",
                "warning",
                `Barrel file re-exports from Node-only module "${importSpecifier}". Move to a subpath export.`,
                relPath,
                lineNumber,
              ),
            );
          }
        }
        RE_EXPORT_PATTERN.lastIndex = 0;
      }
    }
  }
}

export async function runBarrelValidate(
  workspaceRoot: string,
): Promise<KernelCommandResult<BarrelValidateData>> {
  const diagnostics: Diagnostic[] = [];

  const packagesDir = join(workspaceRoot, "packages");
  try {
    await stat(packagesDir);
  } catch {
    return {
      data: {
        command: "ts.barrel.validate",
        status: "pass",
        diagnostics: [],
        summary: emptySummary(),
      },
      exitCode: 0,
      summary: "ts.barrel.validate: pass (no packages directory)",
    };
  }

  await scanBarrelFiles(packagesDir, workspaceRoot, diagnostics);

  const summary = buildSummary(diagnostics);
  const status = summary.error > 0 ? "fail" : summary.warning > 0 ? "warn" : "pass";

  return {
    data: { command: "ts.barrel.validate", status, diagnostics, summary },
    exitCode: summary.error > 0 ? 1 : 0,
    summary: `ts.barrel.validate: ${status} (${summary.error} error(s), ${summary.warning} warning(s))`,
  };
}

export function createBarrelValidateCommand(): KernelCommandDefinition<BarrelValidateData> {
  return {
    name: "ts.barrel.validate",
    description:
      "Validate barrel exports (index.ts) do not re-export Node-only modules without subpath exports (TS-006).",
    scope: "workspace",
    cacheable: true,
    supportsAllSites: false,
    reads: ["packages/**/index.ts", "packages/**/index.tsx"],
    async execute(_input, context) {
      return runBarrelValidate(context.workspaceRoot);
    },
  };
}
