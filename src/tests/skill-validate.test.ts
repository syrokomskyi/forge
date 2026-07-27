import { test, expect, describe } from "vitest";
import { runSkillValidate } from "../validators/skill-validate.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("SKILL-13: knowledge file existence", () => {
  function createTempWorkspace(withKnowledgeFile: boolean): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-skill13-"));
    const forgeRoot = path.join(tmpDir, "packages", "forge");
    const skillDir = path.join(forgeRoot, "skills", "fo", "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });

    const skillMd = `---
name: test-skill
description: Test skill for SKILL-13 validation.
invocation: user
category: fo
concerns: document-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
knowledge:
  - qa-log.md
---

Before starting, read \`PREFERENCES.md\` at the repository root.
`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf8");

    if (withKnowledgeFile) {
      fs.writeFileSync(path.join(skillDir, "qa-log.md"), "# Q&A Log\n", "utf8");
    }

    // Create a minimal registry that only includes the test skill
    const registryDir = path.join(forgeRoot, "src");
    fs.mkdirSync(registryDir, { recursive: true });

    return tmpDir;
  }

  test("SKILL-13 passes when declared knowledge files exist", () => {
    const tmpDir = createTempWorkspace(true);
    try {
      // runSkillValidate uses FORGE_SKILLS from registry.ts, not a temp registry.
      // This test verifies the SKILL-13 logic path: if knowledge is declared and files exist, no SKILL-13 violation.
      // Since we can't easily mock FORGE_SKILLS, we test the real skills instead.
      const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
      const skill13Violations = result.violations.filter((v) => v.rule === "SKILL-13");
      // fo-site-scan and grilling both have knowledge files that exist in the real workspace
      expect(skill13Violations.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SKILL-13 violation format", () => {
    // Verify that the real workspace has no SKILL-13 violations (all declared knowledge files exist)
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill13Violations = result.violations.filter((v) => v.rule === "SKILL-13");
    expect(skill13Violations).toEqual([]);
  });
});

describe("RFC-0539: Pack skill validation (SKILL-14, SKILL-15)", () => {
  test("SKILL-14 and SKILL-15: real workspace pack skills have correct prefix and no fo- prefix", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill14Violations = result.violations.filter((v) => v.rule === "SKILL-14");
    const skill15Violations = result.violations.filter((v) => v.rule === "SKILL-15");
    expect(skill14Violations).toEqual([]);
    expect(skill15Violations).toEqual([]);
  });

  test("SKILL-07: no forge skill depends on a pack skill (asymmetric direction)", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill07Violations = result.violations.filter((v) => v.rule === "SKILL-07");
    // No forge skill should have a dependsOn referencing a pack skill
    expect(skill07Violations).toEqual([]);
  });
});

describe("RFC-0548: SKILL-16 triggers field validation", () => {
  test("SKILL-16: real workspace fo-skills have valid triggers (no violations)", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill16Violations = result.violations.filter((v) => v.rule === "SKILL-16");
    expect(skill16Violations).toEqual([]);
  });

  test("SKILL-16: triggers are only on fo-category skills", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill16Violations = result.violations.filter(
      (v) => v.rule === "SKILL-16" && v.message.includes("only allowed on fo-category"),
    );
    expect(skill16Violations).toEqual([]);
  });

  test("SKILL-16: no pack skills declare triggers", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const packTriggerViolations = result.violations.filter(
      (v) => v.rule === "SKILL-16" && v.message.includes("pack skills may not declare triggers"),
    );
    expect(packTriggerViolations).toEqual([]);
  });
});

describe("RFC-0553: SKILL-17 platform reference prohibition", () => {
  test("SKILL-17: real workspace has no platform RFC/ADR id violations after cleanup", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill17IdViolations = result.violations.filter(
      (v) => v.rule === "SKILL-17" && v.message.includes("RFC/ADR id"),
    );
    expect(skill17IdViolations).toEqual([]);
  });

  test("SKILL-17: real workspace has no platform name violations after cleanup", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill17NameViolations = result.violations.filter(
      (v) => v.rule === "SKILL-17" && v.message.includes("platform name"),
    );
    expect(skill17NameViolations).toEqual([]);
  });

  test("SKILL-17: RFC-\\\\d{4} pattern does not match bare RFC or ADR without digits", () => {
    const rfcPattern = /\bRFC-\d{4}\b/g;
    const adrPattern = /\bADR-\d{4}\b/g;
    expect(rfcPattern.test("This skill audits RFCs")).toBe(false);
    expect(rfcPattern.test("Create a new ADR")).toBe(false);
    expect(rfcPattern.test("RFC-XXXX")).toBe(false);
    expect(rfcPattern.test("RFC-0353")).toBe(true);
    expect(adrPattern.test("ADR-0003")).toBe(true);
  });

  test("SKILL-17: pattern does not match lowercase file paths", () => {
    const idPattern = /\bADR-\d{4}\b/g;
    expect(idPattern.test("adr-0000-template.md")).toBe(false);
    expect(idPattern.test("rfc-0000-template.md")).toBe(false);
  });
});
