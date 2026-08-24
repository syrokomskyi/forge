#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, "..", "dist", "bin", "cli.js");
const srcEntry = resolve(__dirname, "cli.ts");

if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else {
  await import(pathToFileURL(srcEntry).href);
}
