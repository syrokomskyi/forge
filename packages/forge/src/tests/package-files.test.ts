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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");

function readPackageFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    files?: string[];
  };
  return pkg.files ?? [];
}

test("package.json files array includes src/onboarding/templates/", () => {
  const files = readPackageFiles();
  expect(files).toContain("src/onboarding/templates/");
});

test("all template files in src/onboarding/templates/ are covered by files array", () => {
  const files = readPackageFiles();
  const hasTemplatesGlob = files.some(
    (f) => f === "src/onboarding/templates/" || f === "src/onboarding/templates/*",
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
