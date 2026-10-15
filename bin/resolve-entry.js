import { resolve, sep } from "node:path";

/**
 * Pick the forge CLI entry for a given bin directory (RFC-1302).
 *
 * A source checkout (bin not inside node_modules) always runs the TS
 * source: a gitignored dist/ there is never rebuilt by the dogfooding
 * workflow and silently goes stale. Installed packages prefer the built
 * dist/; without it they fall back to tsx.
 *
 * @param {string} binDir
 * @param {(path: string) => boolean} exists
 * @returns {{ kind: "src" | "dist" | "tsx", path: string }}
 */
export function resolveForgeEntry(binDir, exists) {
  const distEntry = resolve(binDir, "..", "dist", "bin", "cli.js");
  const srcEntry = resolve(binDir, "cli.ts");
  // Node type stripping is disabled inside node_modules — a bare
  // `import cli.ts` works only in a source checkout, not for npm consumers.
  const insideNodeModules = binDir.split(sep).includes("node_modules");
  if (!insideNodeModules && exists(srcEntry)) return { kind: "src", path: srcEntry };
  if (exists(distEntry)) return { kind: "dist", path: distEntry };
  return { kind: "tsx", path: srcEntry };
}
