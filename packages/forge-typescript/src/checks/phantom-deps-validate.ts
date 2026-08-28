/*
<MODULE_CONTRACT>
<purpose>ts.phantom.deps.validate — detects phantom dependencies: imports not declared in package.json (TS-003, RFC-0889).</purpose>
<keywords>phantom, deps, validate, typescript</keywords>
<non-goals>
  <item>Does not modify package.json — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial phantom deps validator.</item>
</CHANGE_SUMMARY>
*/

import type {
  KernelCommandDefinition,
  KernelCommandResult,
  Diagnostic,
} from "@warpgogol/werkstatt-engine/kernel/types";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { makeDiagnostic, emptySummary, buildSummary } from "./diagnostic-helpers.ts";

export interface PhantomDepsValidateData {
  command: string;
  status: "pass" | "warn" | "fail";
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
}

const IMPORT_PATTERN = /^\s*import\s+.*?\s+from\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

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

async function scanPackageForPhantomDeps(
  pkgDir: string,
  declaredDeps: Set<string>,
  workspaceRoot: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  const srcDir = join(pkgDir, "src");
  let srcStat;
  try {
    srcStat = await stat(srcDir);
  } catch {
    return;
  }
  if (!srcStat.isDirectory()) return;

  await scanTsFilesForPhantomDeps(srcDir, declaredDeps, workspaceRoot, diagnostics);
}

async function scanTsFilesForPhantomDeps(
  dir: string,
  declaredDeps: Set<string>,
  workspaceRoot: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      await scanTsFilesForPhantomDeps(fullPath, declaredDeps, workspaceRoot, diagnostics);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      const relPath = relative(workspaceRoot, fullPath);
      if (
        relPath.includes("/__tests__/") ||
        relPath.endsWith(".test.ts") ||
        relPath.endsWith(".spec.ts")
      ) {
        continue;
      }

      let content: string;
      try {
        content = await readFile(fullPath, "utf8");
      } catch {
        continue;
      }

      const imports = new Set<string>();
      let match: RegExpExecArray | null;
      IMPORT_PATTERN.lastIndex = 0;
      while ((match = IMPORT_PATTERN.exec(content)) !== null) {
        imports.add(match[1]);
      }
      DYNAMIC_IMPORT_PATTERN.lastIndex = 0;
      while ((match = DYNAMIC_IMPORT_PATTERN.exec(content)) !== null) {
        imports.add(match[1]);
      }

      for (const importSpecifier of imports) {
        const pkgName = extractPackageName(importSpecifier);
        if (pkgName && !declaredDeps.has(pkgName)) {
          diagnostics.push(
            makeDiagnostic(
              "TS-PHANTOM-01",
              "error",
              `Phantom dependency detected: "${pkgName}" is imported but not declared in package.json dependencies or devDependencies.`,
              relPath,
            ),
          );
        }
      }
    }
  }
}

export async function runPhantomDepsValidate(
  workspaceRoot: string,
): Promise<KernelCommandResult<PhantomDepsValidateData>> {
  const diagnostics: Diagnostic[] = [];

  const packagesDir = join(workspaceRoot, "packages");
  let pkgEntries: string[];
  try {
    pkgEntries = await readdir(packagesDir);
  } catch {
    return {
      data: {
        command: "ts.phantom.deps.validate",
        status: "pass",
        diagnostics: [],
        summary: emptySummary(),
      },
      exitCode: 0,
      summary: "ts.phantom.deps.validate: pass (no packages directory)",
    };
  }

  for (const entry of pkgEntries) {
    const pkgDir = join(packagesDir, entry);
    let pkgStat;
    try {
      pkgStat = await stat(pkgDir);
    } catch {
      continue;
    }
    if (!pkgStat.isDirectory()) continue;

    let pkgJson: Record<string, unknown>;
    try {
      const content = await readFile(join(pkgDir, "package.json"), "utf8");
      pkgJson = JSON.parse(content) as Record<string, unknown>;
    } catch {
      continue;
    }

    const deps = Object.keys((pkgJson.dependencies ?? {}) as Record<string, unknown>);
    const devDeps = Object.keys((pkgJson.devDependencies ?? {}) as Record<string, unknown>);
    const peerDeps = Object.keys((pkgJson.peerDependencies ?? {}) as Record<string, unknown>);
    const declaredDeps = new Set([...deps, ...devDeps, ...peerDeps]);

    await scanPackageForPhantomDeps(pkgDir, declaredDeps, workspaceRoot, diagnostics);
  }

  const summary = buildSummary(diagnostics);
  const status = summary.error > 0 ? "fail" : "pass";

  return {
    data: { command: "ts.phantom.deps.validate", status, diagnostics, summary },
    exitCode: summary.error > 0 ? 1 : 0,
    summary: `ts.phantom.deps.validate: ${status} (${summary.error} error(s))`,
  };
}

export function createPhantomDepsValidateCommand(): KernelCommandDefinition<PhantomDepsValidateData> {
  return {
    name: "ts.phantom.deps.validate",
    contract: "ts",
    rules: [],
    description:
      "Detect phantom dependencies: imports not declared in package.json dependencies, devDependencies, or peerDependencies (TS-003).",
    scope: "workspace",
    cacheable: true,
    supportsAllSites: false,
    reads: ["packages/*/package.json", "packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    async execute(_input, context) {
      return runPhantomDepsValidate(context.workspaceRoot);
    },
  };
}
