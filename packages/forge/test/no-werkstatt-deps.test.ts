/*
<MODULE_CONTRACT>
<purpose>Zero-dependency contract node (Werkstatt RFC-1649 AC-3): no package source
in the monorepo may import @warpgogol/werkstatt-engine or @warpgogol/werkstatt-shared.
Blocking and permanent — the structural guarantee that replaced FORGE-AUTONOMY-01.
</purpose>
</MODULE_CONTRACT>
*/

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MONOREPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const FORBIDDEN = /@warpgogol\/werkstatt-(engine|shared)/;

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

describe("no-werkstatt-deps (RFC-1649 AC-3)", () => {
  it("no package source references werkstatt-engine or werkstatt-shared in code", () => {
    const offenders: string[] = [];
    const packagesDir = join(MONOREPO_ROOT, "packages");
    for (const pkg of readdirSync(packagesDir)) {
      const srcRoot = join(packagesDir, pkg);
      if (!statSync(srcRoot).isDirectory()) continue;
      for (const file of walk(srcRoot)) {
        const text = readFileSync(file, "utf-8");
        // strip compass header comment blocks before scanning — historical
        // narrative may name the dead packages, code may not.
        const code = text.replace(/\/\*[\s\S]*?\*\//g, (block) =>
          block.includes("MODULE_CONTRACT") || block.includes("CHANGE_SUMMARY") ? "" : block,
        );
        for (const [lineNo, line] of code.split("\n").entries()) {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
          // the contract is about dependency edges — import/export-from specifiers,
          // dynamic imports, require calls. String mentions in scan patterns,
          // probe targets, or fix hints are data, not dependencies.
          const edge =
            /(?:import|export)\s[^;]*?from\s*["'`]@warpgogol\/werkstatt-(engine|shared)/.test(line) ||
            /import\s*\(\s*["'`]@warpgogol\/werkstatt-(engine|shared)/.test(line) ||
            /require\s*\(\s*["'`]@warpgogol\/werkstatt-(engine|shared)/.test(line);
          if (edge) offenders.push(`${relative(MONOREPO_ROOT, file)}:${lineNo + 1} ${trimmed}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no package.json declares a werkstatt dependency", () => {
    const offenders: string[] = [];
    const packagesDir = join(MONOREPO_ROOT, "packages");
    for (const pkg of readdirSync(packagesDir)) {
      const manifest = join(packagesDir, pkg, "package.json");
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as Record<string, unknown>;
        for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
          const deps = Object.keys((parsed[field] as Record<string, string>) ?? {});
          for (const dep of deps) {
            if (FORBIDDEN.test(dep)) offenders.push(`${pkg}: ${field}.${dep}`);
          }
        }
      } catch {
        // no manifest — not a package dir
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
