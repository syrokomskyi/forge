#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, "..", "dist", "bin", "cli.js");

try {
  await import(distEntry);
} catch (err) {
  if (err && err.code === "ERR_MODULE_NOT_FOUND") {
    console.error("forge: dist/ not found. Run 'pnpm run build' first.");
    process.exit(1);
  }
  throw err;
}
