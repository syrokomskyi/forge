#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, "..", "dist", "bin", "cli.js");
const srcEntry = resolve(__dirname, "cli.ts");

// Node type stripping is disabled inside node_modules — a bare
// `import cli.ts` works only in a source checkout, not for npm consumers.
const insideNodeModules = __dirname.split(sep).includes("node_modules");

if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else if (!insideNodeModules) {
  await import(pathToFileURL(srcEntry).href);
} else {
  // Installed package without a built dist/ — run the TS entry through tsx.
  const result = spawnSync("npx", ["--yes", "tsx", srcEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
