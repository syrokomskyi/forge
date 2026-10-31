/*
<MODULE_CONTRACT>
<purpose>ts.strict.mode.validate — validates strict-mode conventions: unescaped any, missing return types, unjustified @ts-ignore (TS-005, RFC-0889).</purpose>

<non-goals>
  <item>Does not modify source files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1249: wire werkstatt.commands.validate into packages.check + retire CMD-OUTPUT debt</item>
  <item>RFC-1461: declare rules[] severity via CommandRuleDecl workspace-wide (RFC-1461)</item>
  <history>RFC-0889, RFC-1099</history>
</CHANGE_SUMMARY>
*/

import type { KernelCommandDefinition, Diagnostic } from "@warpgogol/werkstatt-shared/kernel/types";
import type { TsWorkspaceModel } from "../model/workspace-model.ts";
import { makeDiagnostic } from "./diagnostic-helpers.ts";
import { defineTsCheck, type TsCheckData } from "./run-ts-check.ts";

export type StrictModeValidateData = TsCheckData;

function check(model: TsWorkspaceModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const pkg of model.packages) {
    for (const file of pkg.sourceFiles) {
      for (const ref of file.anyRefs) {
        if (ref.suppressed) continue;
        diagnostics.push(
          makeDiagnostic(
            "TS-STRICT-01",
            "warning",
            `Unescaped "any" type found. Use "unknown" or add eslint-disable comment if intentional.`,
            file.path,
            ref.line,
          ),
        );
      }

      for (const sup of file.suppressions) {
        if (sup.directive === "ts-ignore" && !sup.justified) {
          diagnostics.push(
            makeDiagnostic(
              "TS-STRICT-02",
              "warning",
              "@ts-ignore without justification comment. Add a comment explaining why the error is suppressed.",
              file.path,
              sup.line,
            ),
          );
        }
      }

      for (const fn of file.exportedFunctions) {
        if (fn.paramsTyped && !fn.hasReturnType) {
          diagnostics.push(
            makeDiagnostic(
              "TS-STRICT-03",
              "warning",
              `Exported function "${fn.name}" missing explicit return type. All exported functions should declare their return type.`,
              file.path,
              fn.line,
            ),
          );
        }
      }
    }
  }

  return diagnostics;
}

export function createStrictModeValidateCommand(): KernelCommandDefinition<StrictModeValidateData> {
  return defineTsCheck({
    name: "ts.strict.mode.validate",
    contract: "ts",
    rules: [{ id: "TS-STRICT-01", severity: "error" }, { id: "TS-STRICT-02", severity: "error" }, { id: "TS-STRICT-03", severity: "error" }],
    modulePath: "packages/werkstatt-typescript/src/checks/strict-mode-validate.ts",
    description:
      "Validate strict-mode conventions: unescaped any, missing return types on exported functions, unjustified @ts-ignore (TS-005).",
    reads: ["packages/**/*.ts", "packages/**/*.tsx", "services/**/*.ts", "services/**/*.tsx"],
    check,
  });
}
