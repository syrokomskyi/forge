#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveForgeEntry } from "./resolve-entry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolveForgeEntry(__dirname, existsSync);

if (entry.kind !== "tsx") {
  await import(pathToFileURL(entry.path).href);
} else {
  // Installed package without a built dist/ — run the TS entry through tsx.
  const result = spawnSync("npx", ["--yes", "tsx", entry.path, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
