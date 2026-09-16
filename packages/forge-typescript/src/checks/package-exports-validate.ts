/*
<MODULE_CONTRACT>
<purpose>ts.package.exports.validate — validates package.json exports entries point to existing files (TS-004, RFC-0889).</purpose>

<non-goals>
  <item>Does not modify package.json — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial package exports validator.</item>
  <item>RFC-1099: rewrite as a pure model-consuming rule via defineTsCheck; existence checks use the model's existingFiles set (no per-rule fs I/O).</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
</CHANGE_SUMMARY>
*/

import type { KernelCommandDefinition, Diagnostic } from "@warpgogol/werkstatt-engine/kernel/types";
import { join } from "node:path";
import type { TsWorkspaceModel } from "../model/workspace-model.ts";
import { makeDiagnostic } from "./diagnostic-helpers.ts";
import { defineTsCheck, type TsCheckData } from "./run-ts-check.ts";

export type PackageExportsValidateData = TsCheckData;

function resolveExportPath(exportEntry: unknown): string[] {
  if (typeof exportEntry === "string") {
    return [exportEntry];
  }

  if (exportEntry && typeof exportEntry === "object") {
    const conditions = exportEntry as Record<string, unknown>;
    const paths: string[] = [];
    for (const key of ["types", "default", "import", "require"]) {
      if (key in conditions) {
        paths.push(...resolveExportPath(conditions[key]));
      }
    }
    return paths;
  }

  return [];
}

function check(model: TsWorkspaceModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const pkg of model.packages) {
    const exportsField = pkg.packageJson.exports;
    if (!exportsField || typeof exportsField !== "object") continue;

    const relPkgJson = `${pkg.dir}/package.json`;

    for (const [exportKey, exportEntry] of Object.entries(exportsField)) {
      if (exportKey === "./package.json") continue;

      for (const target of resolveExportPath(exportEntry)) {
        const relTarget = join(pkg.dir, target);
        if (!pkg.existingFiles.has(relTarget)) {
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

  return diagnostics;
}

export function createPackageExportsValidateCommand(): KernelCommandDefinition<PackageExportsValidateData> {
  return defineTsCheck({
    name: "ts.package.exports.validate",
    contract: "ts",
    rules: ["TS-EXPORTS-01"],
    description: "Validate package.json exports entries point to existing files (TS-004).",
    reads: ["packages/*/package.json", "services/*/package.json"],
    check,
  });
}
