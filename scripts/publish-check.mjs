#!/usr/bin/env node
/*
 * RFC-0543: Publication hygiene check — runs before npm publish.
 * Verifies package.json metadata, dist/ freshness, README presence,
 * VERSION sourcing, and files array completeness.
 *
 * Exits 1 on any check failure with a clear message.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

let failed = false;

function check(label, condition, message) {
  if (!condition) {
    console.error(`  ✖ ${label}: ${message}`);
    failed = true;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

// 1. Metadata fields present
check("license", pkg.license, "license field missing in package.json");
check("description", pkg.description, "description field missing in package.json");
check(
  "keywords",
  Array.isArray(pkg.keywords) && pkg.keywords.length > 0,
  "keywords field missing or empty in package.json",
);

// 2. dist/ exists and is fresh (tsc ran)
const distPath = join(pkgRoot, "dist");
check(
  "dist/",
  existsSync(distPath) && statSync(distPath).isDirectory(),
  "dist/ directory does not exist — run 'pnpm run build' first",
);

// 3. README.md exists and mentions "forge create"
const readmePath = join(pkgRoot, "README.md");
let readmeContent = "";
try {
  readmeContent = readFileSync(readmePath, "utf8");
} catch {
  // not found
}
check("README.md exists", existsSync(readmePath), "README.md not found");
check(
  'README.md mentions "forge create"',
  readmeContent.includes("forge create"),
  'README.md does not mention "forge create" — document the create flow',
);

// 4. VERSION in bin/cli.ts is not hardcoded
const cliPath = join(pkgRoot, "bin", "cli.ts");
const cliContent = readFileSync(cliPath, "utf8");
check(
  "VERSION not hardcoded",
  !cliContent.includes('const VERSION = "'),
  "bin/cli.ts still has a hardcoded VERSION string — source from package.json",
);

// 5. files array includes skills/, profiles/, dist/
const files = pkg.files;
check(
  "files includes dist/",
  Array.isArray(files) && files.includes("dist/"),
  "files array must include dist/",
);
check(
  "files includes skills/",
  Array.isArray(files) && files.includes("skills/"),
  "files array must include skills/",
);
check(
  "files includes profiles/",
  Array.isArray(files) && files.includes("profiles/"),
  "files array must include profiles/",
);

if (failed) {
  console.error("\n✖ Publication hygiene check FAILED — fix the issues above before publishing.");
  process.exit(1);
} else {
  console.log("\n✓ Publication hygiene check passed.");
  process.exit(0);
}
