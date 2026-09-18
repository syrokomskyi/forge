/*
<MODULE_CONTRACT>
<purpose>Verify that template files referenced by source code are included in the npm package
(files array in package.json). Prevents shipping bugs where template files exist on disk
but are missing from the published package.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial test: verify onboarding templates are in package.json files array.</item>
</CHANGE_SUMMARY>
*/

import { test, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveForgePackageRoot } from "../config/forge-config.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");

function readPackageFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    files?: string[];
  };
  return pkg.files ?? [];
}

test("package.json files array includes src/onboarding/templates/", () => {
  const files = readPackageFiles();
  const hasTemplates = files.some(
    (f) => f === "src/onboarding/templates/" || f === "src/onboarding/templates/*" || f === "src/",
  );
  expect(hasTemplates).toBe(true);
});

test("all template files in src/onboarding/templates/ are covered by files array", () => {
  const files = readPackageFiles();
  const hasTemplatesGlob = files.some(
    (f) => f === "src/onboarding/templates/" || f === "src/onboarding/templates/*" || f === "src/",
  );
  expect(hasTemplatesGlob).toBe(true);
});

test("root AGENTS.md templates exist and are readable", () => {
  const templatesDir = join(PACKAGE_ROOT, "src", "onboarding", "templates");

  const templateFiles = readdirSync(templatesDir);
  expect(templateFiles).toContain("root-agents-business.md");
  expect(templateFiles).toContain("root-agents-creative.md");
  expect(templateFiles).toContain("behavioral-layer-core.md");
  expect(templateFiles).toContain("behavioral-layer-extended.md");

  for (const file of templateFiles) {
    const content = readFileSync(join(templatesDir, file), "utf8");
    expect(content.length).toBeGreaterThan(0);
  }
});

// Regression: published 5.1.0 resolved templates/profiles via import.meta.dirname,
// which points at dist/src/onboarding/ in the compiled package — tsc never copies
// .md assets into dist/, so lookups silently failed. resolveForgePackageRoot must
// find the package root from both source and compiled layouts.
test("resolveForgePackageRoot finds package root from compiled dist layout", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-pkgroot-"));
  try {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "@warpgogol/forge" }));
    const distOnboarding = join(tmp, "dist", "src", "onboarding");
    mkdirSync(distOnboarding, { recursive: true });
    const srcTemplates = join(tmp, "src", "onboarding", "templates");
    mkdirSync(srcTemplates, { recursive: true });

    const root = resolveForgePackageRoot(distOnboarding);
    expect(root).toBe(tmp);
    expect(existsSync(join(root, "src", "onboarding", "templates"))).toBe(true);
    expect(existsSync(join(root, "profiles"))).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveForgePackageRoot finds package root from source layout", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-pkgroot-"));
  try {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "@warpgogol/forge" }));
    const srcOnboarding = join(tmp, "src", "onboarding");
    mkdirSync(srcOnboarding, { recursive: true });

    expect(resolveForgePackageRoot(srcOnboarding)).toBe(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveForgePackageRoot resolves the real package root from src/onboarding", () => {
  const root = resolveForgePackageRoot(join(PACKAGE_ROOT, "src", "onboarding"));
  expect(root).toBe(PACKAGE_ROOT);
  expect(existsSync(join(root, "src", "onboarding", "templates"))).toBe(true);
  expect(existsSync(join(root, "profiles"))).toBe(true);
});
