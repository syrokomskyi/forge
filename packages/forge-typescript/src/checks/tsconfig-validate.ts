/*
<MODULE_CONTRACT>
<purpose>ts.tsconfig.validate — validates tsconfig.base.json and per-package tsconfig.json consistency (TS-001, RFC-0889).</purpose>

<non-goals>
  <item>Does not modify tsconfig files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1099: rewrite tsconfig-validate.ts as a pure model-consuming rule via defineTsCheck.</item>
  <item>RFC-1099: steps 7+9 — self-application green + review fixes</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1249: wire werkstatt.commands.validate into packages.check + retire CMD-OUTPUT debt</item>
  <item>RFC-1461: declare rules[] severity via CommandRuleDecl workspace-wide (RFC-1461)</item>
  <history>RFC-0889, RFC-1097</history>
</CHANGE_SUMMARY>
*/

import type { KernelCommandDefinition, Diagnostic } from "@warpgogol/werkstatt-shared/kernel/types";
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
    modulePath: "packages/werkstatt-typescript/src/checks/tsconfig-validate.ts",
    rules: [{ id: "TS-TSCONFIG-01", severity: "error" }, { id: "TS-TSCONFIG-02", severity: "error" }, { id: "TS-TSCONFIG-03", severity: "error" }, { id: "TS-TSCONFIG-04", severity: "error" }, { id: "TS-TSCONFIG-05", severity: "error" }],
    description:
      "Validate tsconfig.base.json and per-package tsconfig.json consistency: strict mode, moduleResolution, target (TS-001).",
    reads: ["tsconfig.base.json", "packages/*/tsconfig.json", "services/*/tsconfig.json"],
    check,
  });
}
