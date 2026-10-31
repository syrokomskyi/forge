/*
<MODULE_CONTRACT>
<purpose>ts.phantom.deps.validate — detects phantom dependencies: imports not declared in package.json (TS-003, RFC-0889).</purpose>

<non-goals>
  <item>Does not modify package.json — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <item>RFC-1099: steps 7+9 — self-application green + review fixes</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1249: wire werkstatt.commands.validate into packages.check + retire CMD-OUTPUT debt</item>
  <item>RFC-1461: declare rules[] severity via CommandRuleDecl workspace-wide (RFC-1461)</item>
  <history>RFC-0889, RFC-1097, RFC-1099</history>
</CHANGE_SUMMARY>
*/

import type { KernelCommandDefinition, Diagnostic } from "@warpgogol/werkstatt-shared/kernel/types";
import { builtinModules } from "node:module";
import type { TsWorkspaceModel } from "../model/workspace-model.ts";
import { makeDiagnostic } from "./diagnostic-helpers.ts";
import { defineTsCheck, type TsCheckData } from "./run-ts-check.ts";

export type PhantomDepsValidateData = TsCheckData;

/** Scheme-prefixed specifiers are virtual/builtin modules, not npm packages (node:, bun:, virtual:, astro:, cloudflare:, data:, …). */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
const NODE_BUILTINS = new Set(builtinModules);

function extractPackageName(specifier: string): string | null {
  if (SCHEME_PREFIX.test(specifier)) return null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;

  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      return parts.slice(0, 2).join("/");
    }
    return null;
  }

  const parts = specifier.split("/");
  const name = parts[0] ?? null;
  if (name && NODE_BUILTINS.has(name)) return null;
  return name;
}

function check(model: TsWorkspaceModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const pkg of model.packages) {
    const declaredDeps = new Set([
      ...Object.keys(pkg.packageJson.dependencies ?? {}),
      ...Object.keys(pkg.packageJson.devDependencies ?? {}),
      ...Object.keys(pkg.packageJson.peerDependencies ?? {}),
      ...Object.keys(pkg.packageJson.optionalDependencies ?? {}),
    ]);
    const selfName = pkg.packageJson.name;

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
      if (pkgName && pkgName !== selfName && !declaredDeps.has(pkgName)) {
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
    rules: [{ id: "TS-PHANTOM-01", severity: "error" }],
    modulePath: "packages/werkstatt-typescript/src/checks/phantom-deps-validate.ts",
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
