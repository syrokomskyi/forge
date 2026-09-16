/*
<MODULE_CONTRACT>
<purpose>ts.phantom.deps.validate — detects phantom dependencies: imports not declared in package.json (TS-003, RFC-0889).</purpose>

<non-goals>
  <item>Does not modify package.json — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial phantom deps validator.</item>
  <item>RFC-1099: rewrite as a pure model-consuming rule via defineTsCheck; scan scope widened from src/ to the whole package; reExports now also checked.</item>
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

export type PhantomDepsValidateData = TsCheckData;

function extractPackageName(specifier: string): string | null {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("virtual:")) return null;

  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      return parts.slice(0, 2).join("/");
    }
    return null;
  }

  const parts = specifier.split("/");
  return parts[0] ?? null;
}

function check(model: TsWorkspaceModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const pkg of model.packages) {
    const declaredDeps = new Set([
      ...Object.keys(pkg.packageJson.dependencies ?? {}),
      ...Object.keys(pkg.packageJson.devDependencies ?? {}),
      ...Object.keys(pkg.packageJson.peerDependencies ?? {}),
    ]);

    const specifiers: { specifier: string; path: string; line: number }[] = [];
    for (const file of pkg.sourceFiles) {
      for (const imp of file.imports) {
        specifiers.push({ specifier: imp.specifier, path: file.path, line: imp.line });
      }
      for (const re of file.reExports) {
        specifiers.push({ specifier: re.specifier, path: file.path, line: re.line });
      }
    }

    for (const { specifier, path, line } of specifiers) {
      const pkgName = extractPackageName(specifier);
      if (pkgName && !declaredDeps.has(pkgName)) {
        diagnostics.push(
          makeDiagnostic(
            "TS-PHANTOM-01",
            "error",
            `Phantom dependency detected: "${pkgName}" is imported but not declared in package.json dependencies or devDependencies.`,
            path,
            line,
          ),
        );
      }
    }
  }

  return diagnostics;
}

export function createPhantomDepsValidateCommand(): KernelCommandDefinition<PhantomDepsValidateData> {
  return defineTsCheck({
    name: "ts.phantom.deps.validate",
    contract: "ts",
    rules: ["TS-PHANTOM-01"],
    description:
      "Detect phantom dependencies: imports not declared in package.json dependencies, devDependencies, or peerDependencies (TS-003).",
    reads: [
      "packages/*/package.json",
      "services/*/package.json",
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "services/**/*.ts",
      "services/**/*.tsx",
    ],
    check,
  });
}
