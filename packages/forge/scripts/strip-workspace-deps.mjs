#!/usr/bin/env node
/*
 * Strip @warpgogol/* workspace:* dependencies from package.json before publish.
 * These packages are not published to npm — they are workspace-only deps.
 * Handlers use dynamic imports (workspace-deps.ts) so the package works
 * standalone without them, degrading gracefully when they're absent.
 *
 * This script runs in prepublishOnly. It modifies package.json in-place,
 * removing workspace:* deps. The git working tree has the original version
 * (with workspace:* deps) — pnpm-lock.yaml is not affected because publish
 * runs from the package directory, not the workspace root.
 *
 * After publish, `git checkout -- packages/forge/package.json` restores
 * the workspace deps for development.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const pkgPath = join(pkgRoot, "package.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const originalDeps = { ...pkg.dependencies };
const stripped = [];

for (const [name, version] of Object.entries(originalDeps)) {
  if (name.startsWith("@warpgogol/") && version === "workspace:*") {
    delete pkg.dependencies[name];
    stripped.push(name);
  }
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

if (stripped.length > 0) {
  console.log(`  ✓ Stripped workspace deps from package.json: ${stripped.join(", ")}`);
  console.log("  ℹ Run 'git checkout -- packages/forge/package.json' after publish to restore workspace deps.");
} else {
  console.log("  ℹ No workspace:* deps found to strip.");
}
