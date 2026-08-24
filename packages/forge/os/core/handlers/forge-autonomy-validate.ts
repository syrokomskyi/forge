/*
<MODULE_CONTRACT>
<purpose>forge.autonomy.validate — scans packages/forge/os/** for forbidden
@warpgogol/werkstatt-engine imports outside os/werkstatt/. Enforces FORGE-AUTONOMY-01
(RFC-0940, DNA-64). @warpgogol/werkstatt-shared is exempt (shared infrastructure).
Type-only imports (import type) are exempt.</purpose>
<keywords>autonomy, guard, RFC-0940, DNA-64, forge, import boundary</keywords>
<non-goals>
  <item>Does not scan test files — .test.ts and .spec.ts are always excluded.</item>
  <item>Does not scan os/werkstatt/ — the adapter directory may import @warpgogol/werkstatt-engine.</item>
  <item>Does not flag @warpgogol/werkstatt-shared — shared infrastructure, not the engine.</item>
  <item>Does not flag import type statements — type-only imports are erased at compile time.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0940: initial forge.autonomy.validate handler implementing FORGE-AUTONOMY-01.</item>
  <item>ADR-0019: inlined scanDirectoryForImports to make forge dependency-free.</item>
</CHANGE_SUMMARY>
*/

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const FORBIDDEN_PACKAGE = "@warpgogol/werkstatt-engine";
const ADAPTER_DIR_PREFIX = "packages/forge/os/werkstatt/";

const EXCLUDE_DIRS = new Set(["node_modules", "tests", "tests-handoff", "dist", "templates"]);
const EXCLUDE_SUFFIXES = [".test.ts", ".spec.ts"];
const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import\s+(?:type\s+)?[^;]+?\s+from\s+|require\s*\(\s*)["'`]([^"'`]+)["'`]/g;

function shouldExcludeFile(fileName: string): boolean {
  return EXCLUDE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

async function scanDirectoryForImports(
  dir: string,
  workspaceRoot: string,
  specifierFilter: (specifier: string) => boolean,
): Promise<{ violations: { file: string; specifier: string }[]; scannedFiles: number }> {
  let scannedFiles = 0;
  const violations: { file: string; specifier: string }[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      const subResult = await scanDirectoryForImports(fullPath, workspaceRoot, specifierFilter);
      scannedFiles += subResult.scannedFiles;
      violations.push(...subResult.violations);
    } else if (entry.name.endsWith(".ts") && !shouldExcludeFile(entry.name)) {
      scannedFiles++;
      const content = await readFile(fullPath, "utf8").catch(() => "");
      let match: RegExpExecArray | null;
      const pattern = new RegExp(IMPORT_PATTERN.source, "g");
      while ((match = pattern.exec(content)) !== null) {
        const specifier = match[1]!;
        if (specifierFilter(specifier)) {
          violations.push({
            file: relative(workspaceRoot, fullPath),
            specifier,
          });
        }
      }
    }
  }

  return { violations, scannedFiles };
}

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
  modules: Record<string, { runtime: "autonomous" | "werkstatt-adapter"; violations: number }>;
}

function isTypeOnlyImport(content: string, specifier: string): boolean {
  const specifierIdx = content.indexOf(specifier);
  if (specifierIdx === -1) return false;

  const importStart = content.lastIndexOf("import", specifierIdx);
  if (importStart === -1) return false;

  const importLine = content.slice(importStart, specifierIdx);
  return /\bimport\s+type\b/.test(importLine);
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
    if (!isTypeOnlyImport(content, v.specifier)) {
      violations.push({
        ruleId: "FORGE-AUTONOMY-01",
        file: v.file,
        specifier: v.specifier,
      });
    }
  }

  const modules: Record<
    string,
    { runtime: "autonomous" | "werkstatt-adapter"; violations: number }
  > = {};
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
