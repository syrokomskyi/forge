/*
<MODULE_CONTRACT>
<purpose>ts.import.boundaries.validate — validates no packages-to-apps import boundary violations (TS-002, RFC-0889).</purpose>

<non-goals>
  <item>Does not modify source files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial import boundaries validator.</item>
  <item>RFC-1099: rewrite as a pure model-consuming rule via defineTsCheck; reExports now also checked.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
</CHANGE_SUMMARY>
*/

import type { KernelCommandDefinition, Diagnostic } from "@warpgogol/werkstatt-engine/kernel/types";
import type { TsWorkspaceModel } from "../model/workspace-model.ts";
import { makeDiagnostic } from "./diagnostic-helpers.ts";
import { defineTsCheck, type TsCheckData } from "./run-ts-check.ts";

export type ImportBoundariesValidateData = TsCheckData;

function checkSpecifier(
  specifier: string,
  relPath: string,
  line: number,
  diagnostics: Diagnostic[],
): void {
  if (specifier.startsWith("apps/") || specifier.startsWith("../apps/")) {
    diagnostics.push(
      makeDiagnostic(
        "TS-IMPORT-01",
        "error",
        `Import boundary violation: packages must not import from apps. Found import of "${specifier}".`,
        relPath,
        line,
      ),
    );
  }
  if (specifier.includes("/missions/") || specifier.startsWith("../missions/")) {
    diagnostics.push(
      makeDiagnostic(
        "TS-IMPORT-02",
        "error",
        `Import boundary violation: packages must not import from missions. Found import of "${specifier}".`,
        relPath,
        line,
      ),
    );
  }
}

function check(model: TsWorkspaceModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const pkg of model.packages) {
    for (const file of pkg.sourceFiles) {
      for (const imp of file.imports) {
        checkSpecifier(imp.specifier, file.path, imp.line, diagnostics);
      }
      for (const re of file.reExports) {
        checkSpecifier(re.specifier, file.path, re.line, diagnostics);
      }
    }
  }
  return diagnostics;
}

export function createImportBoundariesValidateCommand(): KernelCommandDefinition<ImportBoundariesValidateData> {
  return defineTsCheck({
    name: "ts.import.boundaries.validate",
    contract: "ts",
    rules: ["TS-IMPORT-01", "TS-IMPORT-02"],
    description:
      "Validate import boundaries: no packages-to-apps or packages-to-missions imports (TS-002).",
    reads: ["packages/**/*.ts", "packages/**/*.tsx", "services/**/*.ts", "services/**/*.tsx"],
    check,
  });
}
