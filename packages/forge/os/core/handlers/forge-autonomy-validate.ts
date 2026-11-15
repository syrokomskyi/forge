/*
<MODULE_CONTRACT>
<purpose>forge.autonomy.validate — scans packages/forge/os/** for forbidden
@warpgogol/werkstatt-engine imports outside os/werkstatt/. Enforces FORGE-AUTONOMY-01
(RFC-0940, DNA-64). @warpgogol/werkstatt-shared is exempt (shared infrastructure).
Type-only imports (import type) are exempt.</purpose>

<non-goals>
  <item>Does not scan test files — .test.ts and .spec.ts are always excluded.</item>
  <item>Does not scan os/werkstatt/ — the adapter directory may import @warpgogol/werkstatt-engine.</item>
  <item>Does not flag @warpgogol/werkstatt-shared — shared infrastructure, not the engine.</item>
  <item>Does not flag import type statements — type-only imports are erased at compile time.</item>
  <item>RFC-1606: the strip-types arm (FORGE-AUTONOMY-02) covers the os/ + bin/ trees — diagnostics in imported dependency sources (werkstatt-shared etc.) are reported under outOfScopeDiagnostics, not violations.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0940: initial forge.autonomy.validate handler implementing FORGE-AUTONOMY-01.</item>
  <item>ADR-0019: inlined scanDirectoryForImports to make forge dependency-free.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
</CHANGE_SUMMARY>
*/

import { join, relative } from "node:path";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;
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
  const entries = await io.readdir(dir).catch(() => []);

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      const subResult = await scanDirectoryForImports(fullPath, workspaceRoot, specifierFilter);
      scannedFiles += subResult.scannedFiles;
      violations.push(...subResult.violations);
    } else if (entry.name.endsWith(".ts") && !shouldExcludeFile(entry.name)) {
      scannedFiles++;
      const content = await io.readFile(fullPath).catch(() => "");
      let match: RegExpExecArray | null;
      const pattern = new RegExp(IMPORT_PATTERN.source, "g");
      while ((match = pattern.exec(content)) !== null) {
        const specifier = match[1]!;
        if (specifierFilter(specifier)) {
          violations.push({
            // Reported paths are repo-relative logical paths — forward
            // slashes on every platform.
            file: relative(workspaceRoot, fullPath).replace(/\\/g, "/"),
            specifier,
          });
        }
      }
    }
  }

  return { violations, scannedFiles };
}

export interface ForgeAutonomyViolation {
  ruleId: "FORGE-AUTONOMY-01" | "FORGE-AUTONOMY-02";
  file: string;
  specifier?: string;
  message?: string;
}

export interface ForgeAutonomyValidateResult {
  command: "forge.autonomy.validate";
  status: "pass" | "fail";
  violations: ForgeAutonomyViolation[];
  scannedFiles: number;
  modules: Record<string, { runtime: "autonomous" | "werkstatt-adapter"; violations: number }>;
  stripTypes?: {
    diagnosticFiles: number;
    durationMs: number;
    skipped?: string;
    outOfScopeDiagnostics: number;
  };
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
  const io = resolveIo(context.io);
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
    const content = await io.readFile(fullPath).catch(() => "");
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

  // ── RFC-1606 AC-3: FORGE-AUTONOMY-02 strip-types arm ──────────────────
  // `node --experimental-strip-types` can only strip erasable syntax — any
  // runtime TypeScript construct (parameter properties, enums, namespaces)
  // in os/** + bin/** breaks the standalone CLI under strip-types. The arm
  // spawns `tsc -p tsconfig.strip-types.json` and parses its diagnostics;
  // diagnostics inside imported dependency sources (werkstatt-shared etc.)
  // are out of scope and reported separately rather than failing the arm.
  const stripTypes = await runStripTypesArm(workspaceRoot, io);
  for (const v of stripTypes.violations) violations.push(v);

  const status = violations.length === 0 ? "pass" : "fail";

  return {
    data: {
      command: "forge.autonomy.validate",
      status,
      violations,
      scannedFiles,
      modules,
      stripTypes: {
        diagnosticFiles: stripTypes.checkedFiles,
        durationMs: stripTypes.durationMs,
        skipped: stripTypes.skipped,
        outOfScopeDiagnostics: stripTypes.outOfScopeDiagnostics,
      },
    },
    exitCode: status === "pass" ? 0 : 1,
    summary: `[forge.autonomy.validate] ${status.toUpperCase()} — ${violations.length} violation(s) across ${scannedFiles} files`,
  };
}

const armErrMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Diagnostic line shape: `path(line,col): error TSnnnn: message`. */
const TSC_DIAG_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

/**
 * FORGE-AUTONOMY-02 — the os/ + bin/ trees must be erasable-syntax-only
 * (F-0227, RFC-1606). Runs `tsc -p tsconfig.strip-types.json` scoped to the
 * forge package; diagnostics outside the package's own os//bin trees are
 * dependency-source findings — reported as outOfScopeDiagnostics, never
 * violations. Degrades (never blocks) when io lacks exec.
 */
async function runStripTypesArm(
  workspaceRoot: string,
  ioArg: typeof ambientIo,
): Promise<{
  violations: ForgeAutonomyViolation[];
  checkedFiles: number;
  durationMs: number;
  skipped?: string;
  outOfScopeDiagnostics: number;
}> {
  const started = Date.now();
  const empty = {
    violations: [] as ForgeAutonomyViolation[],
    checkedFiles: 0,
    durationMs: 0,
    outOfScopeDiagnostics: 0,
  };
  if (typeof ioArg.exec !== "function") {
    return { ...empty, skipped: "io.exec unavailable" };
  }
  const forgeDir = join(workspaceRoot, "packages", "forge");
  const tscBin = join(forgeDir, "node_modules", ".bin", "tsc");
  // Reduced/fake workspaces carry no node_modules — degrade like a missing
  // exec rather than refusing the scan (io.exec-lacks rule, RFC-1606).
  if (typeof ioArg.exists === "function" && !(await ioArg.exists(tscBin))) {
    return { ...empty, skipped: "tsc binary unavailable" };
  }
  // Direct binary — `pnpm exec` rewrites pnpm-lock.yaml as a side effect
  // (F-0201), and this arm must not dirty the tree it inspects.
  let res: { stdout?: string; stderr?: string };
  try {
    res = await ioArg.exec(
      tscBin,
      ["-p", "tsconfig.strip-types.json", "--noEmit"],
      { cwd: forgeDir },
    );
  } catch (err) {
    return { ...empty, skipped: `tsc spawn failed: ${armErrMessage(err)}` };
  }
  const durationMs = Date.now() - started;
  const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const violations: ForgeAutonomyViolation[] = [];
  let outOfScopeDiagnostics = 0;
  const diagnosticFiles = new Set<string>();
  for (const line of output.split("\n")) {
    const m = TSC_DIAG_LINE.exec(line.trim());
    if (!m) continue;
    const [, rawPath, lineNo, , code, message] = m;
    const rel = rawPath!.replace(/\\/g, "/");
    diagnosticFiles.add(rel);
    // Scope: only diagnostics inside this package's os//bin trees fail the
    // arm — imported dependency sources are reported, not refused (RFC-1606).
    const inScope = !rel.includes("../") && /^(os|bin)\//.test(rel);
    if (!inScope) {
      outOfScopeDiagnostics++;
      continue;
    }
    violations.push({
      ruleId: "FORGE-AUTONOMY-02",
      file: `packages/forge/${rel}`,
      message: `${code} at line ${lineNo}: ${message}`,
    });
  }
  return { violations, checkedFiles: diagnosticFiles.size, durationMs, outOfScopeDiagnostics };
}
