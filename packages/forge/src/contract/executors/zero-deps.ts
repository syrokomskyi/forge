/*
<MODULE_CONTRACT>
<purpose>
Zero-dependency scan as a reusable contract-graph executor substrate (Werkstatt
RFC-1649 AC-3 / RFC-1646): no TypeScript source in the scanned tree may import
@warpgogol/werkstatt-engine or @warpgogol/werkstatt-shared, and no package.json
may declare them. Import-syntax precision — string mentions in scan patterns or
documentation are data, not dependency edges.
</purpose>
<non-goals>
  <item>No test harness — pure scan returning violations; callers wire verdicts.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1646 (WP-3c): extracted from the AC-3 contract test for graph reuse.</item>
</CHANGE_SUMMARY>
*/

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { Violation } from "../types.ts";

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

export function scanWerkstattDeps(treeRoot: string): Violation[] {
  const violations: Violation[] = [];
  const packagesDir = join(treeRoot, "packages");
  let pkgEntries: string[] = [];
  try {
    pkgEntries = readdirSync(packagesDir);
  } catch {
    return violations; // no packages dir — nothing to scan
  }
  for (const pkg of pkgEntries) {
    const srcRoot = join(packagesDir, pkg);
    if (!statSync(srcRoot).isDirectory()) continue;
    for (const file of walk(srcRoot)) {
      const text = readFileSync(file, "utf-8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, (block) =>
        block.includes("MODULE_CONTRACT") || block.includes("CHANGE_SUMMARY") ? "" : block,
      );
      for (const [lineNo, line] of code.split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        const edge =
          /(?:import|export)\s[^;]*?from\s*["'`]@warpgogol\/werkstatt-(engine|shared)/.test(line) ||
          /import\s*\(\s*["'`]@warpgogol\/werkstatt-(engine|shared)/.test(line) ||
          /require\s*\(\s*["'`]@warpgogol\/werkstatt-(engine|shared)/.test(line);
        if (edge) {
          violations.push({
            ruleId: "ZERO-DEP-01",
            message: `${relative(treeRoot, file)}:${lineNo + 1} imports a werkstatt package`,
            severity: "blocking",
            file: relative(treeRoot, file),
            line: lineNo + 1,
          });
        }
      }
    }
    try {
      const pkgJson = JSON.parse(readFileSync(join(srcRoot, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const deps of [pkgJson.dependencies, pkgJson.devDependencies]) {
        for (const name of Object.keys(deps ?? {})) {
          if (name === "@warpgogol/werkstatt-engine" || name === "@warpgogol/werkstatt-shared") {
            violations.push({
              ruleId: "ZERO-DEP-02",
              message: `${pkg}/package.json declares ${name}`,
              severity: "blocking",
              file: `${pkg}/package.json`,
            });
          }
        }
      }
    } catch {
      // no manifest — nothing to check
    }
  }
  return violations;
}
