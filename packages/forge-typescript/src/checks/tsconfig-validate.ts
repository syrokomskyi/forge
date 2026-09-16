/*
<MODULE_CONTRACT>
<purpose>ts.tsconfig.validate — validates tsconfig.base.json and per-package tsconfig.json consistency (TS-001, RFC-0889).</purpose>

<non-goals>
  <item>Does not modify tsconfig files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial tsconfig validator.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <item>RFC-1099: rewrite tsconfig-validate.ts as a pure model-consuming rule via defineTsCheck.</item>
  <item>RFC-1099: steps 7+9 — self-application green + review fixes</item>
</CHANGE_SUMMARY>
*/

import type { KernelCommandDefinition, Diagnostic } from "@warpgogol/werkstatt-engine/kernel/types";
import type { TsWorkspaceModel } from "../model/workspace-model.ts";
import { makeDiagnostic } from "./diagnostic-helpers.ts";
import { defineTsCheck, type TsCheckData } from "./run-ts-check.ts";

export type TsconfigValidateData = TsCheckData;

function check(model: TsWorkspaceModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (model.baseTsconfig === null) {
    diagnostics.push(
      makeDiagnostic(
        "TS-TSCONFIG-01",
        "error",
        "tsconfig.base.json not found at workspace root. All workspace packages must extend a shared base config.",
        "tsconfig.base.json",
      ),
    );
    return diagnostics;
  }

  const baseCompilerOptions = model.baseTsconfig.compilerOptions ?? {};

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

  for (const pkg of model.packages) {
    const relPath = `${pkg.dir}/tsconfig.json`;

    if (pkg.tsconfigMalformed) {
      diagnostics.push(
        makeDiagnostic(
          "TS-TSCONFIG-05",
          "error",
          "Failed to read or parse tsconfig.json.",
          relPath,
        ),
      );
      continue;
    }

    if (pkg.tsconfig === null) continue;

    const compilerOptions = pkg.tsconfig.compilerOptions ?? {};

    // module:NodeNext implies moduleResolution:NodeNext — an explicit coupled pair is a
    // deliberate Node-resolution choice (e.g. published CLI), not drift from the base.
    const coupledNodeNext =
      compilerOptions.module === "NodeNext" && compilerOptions.moduleResolution === "NodeNext";

    if (
      expectedModuleResolution !== undefined &&
      compilerOptions.moduleResolution !== undefined &&
      compilerOptions.moduleResolution !== expectedModuleResolution &&
      !coupledNodeNext
    ) {
      diagnostics.push(
        makeDiagnostic(
          "TS-TSCONFIG-03",
          "error",
          `moduleResolution mismatch: expected "${String(expectedModuleResolution)}", got "${String(compilerOptions.moduleResolution)}".`,
          relPath,
        ),
      );
    }

    if (
      expectedTarget !== undefined &&
      compilerOptions.target !== undefined &&
      compilerOptions.target !== expectedTarget
    ) {
      diagnostics.push(
        makeDiagnostic(
          "TS-TSCONFIG-04",
          "error",
          `target mismatch: expected "${String(expectedTarget)}", got "${String(compilerOptions.target)}".`,
          relPath,
        ),
      );
    }
  }

  return diagnostics;
}

export function createTsconfigValidateCommand(): KernelCommandDefinition<TsconfigValidateData> {
  return defineTsCheck({
    name: "ts.tsconfig.validate",
    contract: "ts",
    rules: [
      "TS-TSCONFIG-01",
      "TS-TSCONFIG-02",
      "TS-TSCONFIG-03",
      "TS-TSCONFIG-04",
      "TS-TSCONFIG-05",
    ],
    description:
      "Validate tsconfig.base.json and per-package tsconfig.json consistency: strict mode, moduleResolution, target (TS-001).",
    reads: ["tsconfig.base.json", "packages/*/tsconfig.json", "services/*/tsconfig.json"],
    check,
  });
}
