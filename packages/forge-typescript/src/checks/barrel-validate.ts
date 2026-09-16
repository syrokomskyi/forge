/*
<MODULE_CONTRACT>
<purpose>ts.barrel.validate — validates barrel exports (index.ts) do not re-export Node-only modules without subpath exports (TS-006, RFC-0889).</purpose>

<non-goals>
  <item>Does not modify barrel files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial barrel validator.</item>
  <item>RFC-1099: rewrite as a pure model-consuming rule via defineTsCheck; regexes replaced by AST facts (imports, reExports).</item>
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

export type BarrelValidateData = TsCheckData;

const BARREL_BASENAMES = new Set(["index.ts", "index.tsx"]);

function isBarrelFile(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return BARREL_BASENAMES.has(base);
}

function check(model: TsWorkspaceModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const pkg of model.packages) {
    for (const file of pkg.sourceFiles) {
      if (!isBarrelFile(file.path)) continue;

      for (const imp of file.imports) {
        if (imp.specifier.startsWith("node:")) {
          diagnostics.push(
            makeDiagnostic(
              "TS-BARREL-01",
              "warning",
              `Barrel file imports Node-only module "${imp.specifier}". Use a subpath export for client-side isolation.`,
              file.path,
              imp.line,
            ),
          );
        }
      }

      for (const re of file.reExports) {
        if (re.specifier.startsWith("node:")) {
          diagnostics.push(
            makeDiagnostic(
              "TS-BARREL-02",
              "warning",
              `Barrel file re-exports from Node-only module "${re.specifier}". Move to a subpath export.`,
              file.path,
              re.line,
            ),
          );
        }
      }
    }
  }

  return diagnostics;
}

export function createBarrelValidateCommand(): KernelCommandDefinition<BarrelValidateData> {
  return defineTsCheck({
    name: "ts.barrel.validate",
    contract: "ts",
    rules: ["TS-BARREL-01", "TS-BARREL-02"],
    description:
      "Validate barrel exports (index.ts) do not re-export Node-only modules without subpath exports (TS-006).",
    reads: [
      "packages/**/index.ts",
      "packages/**/index.tsx",
      "services/**/index.ts",
      "services/**/index.tsx",
    ],
    check,
  });
}
