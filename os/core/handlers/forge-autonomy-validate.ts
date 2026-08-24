/*
<MODULE_CONTRACT>
<purpose>forge.autonomy.validate — scans packages/forge/os/** for forbidden
@warpgogol/werkstatt imports outside os/werkstatt/. Enforces FORGE-AUTONOMY-01
(RFC-0940, DNA-64). @warpgogol/werkstatt-shared is exempt (shared infrastructure).
Type-only imports (import type) are exempt.</purpose>
<keywords>autonomy, guard, RFC-0940, DNA-64, forge, import boundary</keywords>
<non-goals>
  <item>Does not scan test files — .test.ts and .spec.ts are always excluded.</item>
  <item>Does not scan os/werkstatt/ — the adapter directory may import @warpgogol/werkstatt.</item>
  <item>Does not flag @warpgogol/werkstatt-shared — shared infrastructure, not the engine.</item>
  <item>Does not flag import type statements — type-only imports are erased at compile time.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0940: initial forge.autonomy.validate handler implementing FORGE-AUTONOMY-01.</item>
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanDirectoryForImports } from "@warpgogol/werkstatt-shared/share/import-scan";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const FORBIDDEN_PACKAGE = "@warpgogol/werkstatt";
const ADAPTER_DIR_PREFIX = "packages/forge/os/werkstatt/";

export interface ForgeAutonomyViolation {
  ruleId: "FORGE-AUTONOMY-01";
  file: string;
  specifier: string;
}

export interface ForgeAutonomyValidateResult {
  command: "forge.autonomy.validate";
  status: "pass" | "fail";
  violations: ForgeAutonomyViolation[];
  scannedFiles: number;
  modules: Record<string, { runtime: string; violations: number }>;
}

function isTypeOnlyImportLine(line: string, specifier: string): boolean {
  const idx = line.indexOf(specifier);
  if (idx === -1) return false;
  const before = line.slice(0, idx);
  return /\bimport\s+type\b/.test(before);
}

export async function runForgeAutonomyValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeAutonomyValidateResult>> {
  const workspaceRoot = context.workspaceRoot;
  const forgeOsDir = join(workspaceRoot, "packages", "forge", "os");

  const { violations: rawViolations, scannedFiles } = await scanDirectoryForImports(
    forgeOsDir,
    workspaceRoot,
    (specifier) => specifier === FORBIDDEN_PACKAGE || specifier.startsWith(FORBIDDEN_PACKAGE + "/"),
  );

  const violations: ForgeAutonomyViolation[] = [];
  for (const v of rawViolations) {
    if (v.file.startsWith(ADAPTER_DIR_PREFIX)) continue;

    const fullPath = join(workspaceRoot, v.file);
    const content = await readFile(fullPath, "utf8").catch(() => "");
    const lines = content.split("\n");
    const hasRuntimeImport = lines.some(
      (line: string) => line.includes(v.specifier) && !isTypeOnlyImportLine(line, v.specifier),
    );
    if (hasRuntimeImport) {
      violations.push({
        ruleId: "FORGE-AUTONOMY-01",
        file: v.file,
        specifier: v.specifier,
      });
    }
  }

  const modules: Record<string, { runtime: string; violations: number }> = {};
  for (const v of violations) {
    const parts = v.file.split("/");
    const modKey = parts.slice(0, 4).join("/");
    if (!modules[modKey]) {
      const isAdapter = v.file.startsWith(ADAPTER_DIR_PREFIX);
      modules[modKey] = {
        runtime: isAdapter ? "werkstatt-adapter" : "autonomous",
        violations: 0,
      };
    }
    modules[modKey]!.violations++;
  }

  const status = violations.length === 0 ? "pass" : "fail";

  return {
    data: {
      command: "forge.autonomy.validate",
      status,
      violations,
      scannedFiles,
      modules,
    },
    exitCode: status === "pass" ? 0 : 1,
    summary: `[forge.autonomy.validate] ${status.toUpperCase()} — ${violations.length} violation(s) across ${scannedFiles} files`,
  };
}
