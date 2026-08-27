/*
<MODULE_CONTRACT>
<purpose>ts.package.exports.validate — validates package.json exports entries point to existing files (TS-004, RFC-0889).</purpose>
<keywords>exports, package, validate, typescript</keywords>
<non-goals>
  <item>Does not modify package.json — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial package exports validator.</item>
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

export interface PackageExportsValidateData {
  command: string;
  status: "pass" | "warn" | "fail";
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
}

function resolveExportPath(exportEntry: unknown, pkgDir: string): string[] {
  if (typeof exportEntry === "string") {
    return [join(pkgDir, exportEntry)];
  }

  if (exportEntry && typeof exportEntry === "object") {
    const conditions = exportEntry as Record<string, unknown>;
    const paths: string[] = [];
    for (const key of ["types", "default", "import", "require"]) {
      if (key in conditions) {
        const subPaths = resolveExportPath(conditions[key], pkgDir);
        paths.push(...subPaths);
      }
    }
    return paths;
  }

  return [];
}

export async function runPackageExportsValidate(
  workspaceRoot: string,
): Promise<KernelCommandResult<PackageExportsValidateData>> {
  const diagnostics: Diagnostic[] = [];

  const packagesDir = join(workspaceRoot, "packages");
  let pkgEntries: string[];
  try {
    pkgEntries = await readdir(packagesDir);
  } catch {
    return {
      data: {
        command: "ts.package.exports.validate",
        status: "pass",
        diagnostics: [],
        summary: emptySummary(),
      },
      exitCode: 0,
      summary: "ts.package.exports.validate: pass (no packages directory)",
    };
  }

  for (const entry of pkgEntries) {
    const pkgDir = join(packagesDir, entry);
    let pkgStat;
    try {
      pkgStat = await stat(pkgDir);
    } catch {
      continue;
    }
    if (!pkgStat.isDirectory()) continue;

    let pkgJson: Record<string, unknown>;
    try {
      const content = await readFile(join(pkgDir, "package.json"), "utf8");
      pkgJson = JSON.parse(content) as Record<string, unknown>;
    } catch {
      continue;
    }

    const exportsField = pkgJson.exports;
    if (!exportsField || typeof exportsField !== "object") continue;

    const relPkgJson = relative(workspaceRoot, join(pkgDir, "package.json"));

    for (const [exportKey, exportEntry] of Object.entries(
      exportsField as Record<string, unknown>,
    )) {
      if (exportKey === "./package.json") continue;

      const targetPaths = resolveExportPath(exportEntry, pkgDir);
      for (const targetPath of targetPaths) {
        try {
          await stat(targetPath);
        } catch {
          const relTarget = relative(workspaceRoot, targetPath);
          diagnostics.push(
            makeDiagnostic(
              "TS-EXPORTS-01",
              "error",
              `Package exports entry "${exportKey}" points to non-existent file: ${relTarget}.`,
              relPkgJson,
            ),
          );
        }
      }
    }
  }

  const summary = buildSummary(diagnostics);
  const status = summary.error > 0 ? "fail" : "pass";

  return {
    data: { command: "ts.package.exports.validate", status, diagnostics, summary },
    exitCode: summary.error > 0 ? 1 : 0,
    summary: `ts.package.exports.validate: ${status} (${summary.error} error(s))`,
  };
}

export function createPackageExportsValidateCommand(): KernelCommandDefinition<PackageExportsValidateData> {
  return {
    name: "ts.package.exports.validate",
    description: "Validate package.json exports entries point to existing files (TS-004).",
    scope: "workspace",
    cacheable: true,
    supportsAllSites: false,
    reads: ["packages/*/package.json"],
    async execute(_input, context) {
      return runPackageExportsValidate(context.workspaceRoot);
    },
  };
}
