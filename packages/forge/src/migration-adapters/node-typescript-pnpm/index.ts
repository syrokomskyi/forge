/*
<MODULE_CONTRACT>
<purpose>Node/TypeScript/pnpm migration adapter — detects Node+TS+pnpm projects, derives bindings, copies code into forge turborepo (RFC-0546).</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not transform business logic — copy only.</item>
  <item>Do not overwrite forge-protected files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0546: initial node-typescript-pnpm migration adapter.</item>
  <item>RFC-0547: implement postSetup with git init / format-patch + git am.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import type { MigrationAdapter, AdapterAnalysis, MigrationResult, Conflict } from "../types.ts";
import { FORGE_PROTECTED_PATHS, DEFAULT_EXCLUDE_PATTERNS } from "../types.ts";
import { runPostSetup } from "../git-utils.ts";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(sourceDir: string): PackageJson | null {
  const pkgPath = path.join(sourceDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

export const nodeTypescriptPnpmAdapter: MigrationAdapter = {
  id: "node-typescript-pnpm",

  detect(sourceDir: string): boolean {
    const hasPackageJson = fs.existsSync(path.join(sourceDir, "package.json"));
    const hasTsconfig = fs.existsSync(path.join(sourceDir, "tsconfig.json"));
    const hasPnpmLock = fs.existsSync(path.join(sourceDir, "pnpm-lock.yaml"));
    return hasPackageJson && hasTsconfig && hasPnpmLock;
  },

  analyze(sourceDir: string): AdapterAnalysis {
    const pkg = readPackageJson(sourceDir) ?? {};
    const scripts = pkg.scripts ?? {};

    const typecheck =
      scripts["build:check"] ?? ((scripts["typecheck"] ?? scripts["tsc"]) ? `tsc --noEmit` : null);
    const test = scripts["test"] ?? null;
    const scopedBuild = scripts["build"] ?? null;

    const appName = pkg.name
      ? pkg.name
          .replace(/^@[^/]+\//, "")
          .replace(/[^a-z0-9-]/gi, "-")
          .toLowerCase()
      : path
          .basename(sourceDir)
          .toLowerCase()
          .replace(/[^a-z0-9-]/gi, "-");

    return {
      stack: ["typescript", "node"],
      packageManager: "pnpm",
      bindings: { typecheck, test, scopedBuild },
      placement: "apps",
      appName,
      excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
      gitHistory: fs.existsSync(path.join(sourceDir, ".git")),
    };
  },

  migrate(sourceDir: string, targetDir: string, analysis: AdapterAnalysis): MigrationResult {
    const destDir = path.join(targetDir, analysis.placement, analysis.appName);
    const filesCopied: string[] = [];
    const filesSkipped: string[] = [];
    const conflicts: Conflict[] = [];

    copyDirectory(
      sourceDir,
      destDir,
      sourceDir,
      analysis.excludePatterns,
      filesCopied,
      filesSkipped,
      conflicts,
    );

    let workspaceUpdated = false;
    const workspacePath = path.join(targetDir, "pnpm-workspace.yaml");
    if (fs.existsSync(workspacePath)) {
      const content = fs.readFileSync(workspacePath, "utf8");
      const entry = `  - ${analysis.placement}/${analysis.appName}`;
      if (!content.includes(entry)) {
        const updated = content.trimEnd() + "\n" + entry + "\n";
        fs.writeFileSync(workspacePath, updated);
        workspaceUpdated = true;
      }
    }

    const turboPath = path.join(targetDir, "turbo.json");
    if (fs.existsSync(turboPath)) {
      try {
        const turbo = JSON.parse(fs.readFileSync(turboPath, "utf8")) as Record<string, unknown>;
        if (turbo && typeof turbo === "object") {
          fs.writeFileSync(turboPath, JSON.stringify(turbo, null, 2) + "\n");
          workspaceUpdated = true;
        }
      } catch {
        // turbo.json parse failure — skip update
      }
    }

    return { filesCopied, filesSkipped, conflicts, workspaceUpdated };
  },

  postSetup(sourceDir: string, targetDir: string, analysis: AdapterAnalysis): void {
    runPostSetup(sourceDir, targetDir, analysis);
  },
};

function isForgeProtected(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return FORGE_PROTECTED_PATHS.some((p) => normalized === p || normalized.startsWith(p + "/"));
}

function isExcluded(relPath: string, patterns: string[]): boolean {
  const parts = relPath.split(path.sep);
  return patterns.some((p) => parts.includes(p));
}

function copyDirectory(
  src: string,
  dest: string,
  rootSrc: string,
  excludePatterns: string[],
  filesCopied: string[],
  filesSkipped: string[],
  conflicts: Conflict[],
): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relPath = path.relative(rootSrc, srcPath);

    if (entry.isDirectory()) {
      if (isExcluded(relPath, excludePatterns)) continue;
      copyDirectory(
        srcPath,
        destPath,
        rootSrc,
        excludePatterns,
        filesCopied,
        filesSkipped,
        conflicts,
      );
    } else if (entry.isFile()) {
      if (isExcluded(relPath, excludePatterns)) continue;

      if (isForgeProtected(relPath)) {
        filesSkipped.push(relPath);
        continue;
      }

      if (fs.existsSync(destPath)) {
        conflicts.push({
          path: relPath,
          sourceExists: true,
          forgeExists: true,
          resolution: "source-wins",
        });
      }

      fs.copyFileSync(srcPath, destPath);
      filesCopied.push(relPath);
    }
  }
}
