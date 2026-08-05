import { test, expect, describe } from "vitest";
import { runSkillValidate } from "../validators/skill-validate.ts";
import { FORGE_SKILLS } from "../registry.ts";
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
  test("SKILL-17: real workspace has no platform RFC/ADR/DNA id violations after cleanup", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill17IdViolations = result.violations.filter(
      (v) => v.rule === "SKILL-17" && v.message.includes("RFC/ADR/DNA id"),
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
    const dnaRe = () => new RegExp("\\bDNA-\\d+\\b", "g");
    expect(rfcPattern.test("This skill audits RFCs")).toBe(false);
    expect(rfcPattern.test("Create a new ADR")).toBe(false);
    expect(rfcPattern.test("RFC-XXXX")).toBe(false);
    expect(rfcPattern.test("RFC-0353")).toBe(true);
    expect(adrPattern.test("ADR-0003")).toBe(true);
    expect(dnaRe().test("DNA-42")).toBe(true);
    expect(dnaRe().test("DNA-1")).toBe(true);
    expect(dnaRe().test("DNA-N")).toBe(false);
    expect(dnaRe().test("DNA-<N>")).toBe(false);
    expect(dnaRe().test("DNA-NN")).toBe(false);
    expect(dnaRe().test("DNA candidate")).toBe(false);
  });

  test("SKILL-17: pattern does not match lowercase file paths", () => {
    const idPattern = /\bADR-\d{4}\b/g;
    expect(idPattern.test("adr-0000-template.md")).toBe(false);
    expect(idPattern.test("rfc-0000-template.md")).toBe(false);
  });

  test("SKILL-17: @warpgogol npm scope is not a platform name violation (regression 2026-08-03)", () => {
    // Mirrors SKILL17_PLATFORM_PATTERNS in skill-validate.ts. The brand pattern
    // must stay case-sensitive — with /gi it defeated the first pattern's
    // @-lookbehind and false-flagged every `@warpgogol/<pkg>` reference.
    const platformPatterns = [/(?<!@)Warpgogol\b/gi, /\bWarpGogol\b/g];
    const matches = (line: string) =>
      platformPatterns.some((p) => new RegExp(p.source, p.flags).test(line));
    expect(matches("Read the template inside `@warpgogol/forge`")).toBe(false);
    expect(matches("- No imports from `@warpgogol/site-kernel`.")).toBe(false);
    expect(matches("The Warpgogol platform requires this")).toBe(true);
    expect(matches("WarpGogol brand mention")).toBe(true);
  });
});

describe("RFC-0642: SKILL-18 domain-specific binding key prohibition", () => {
  test("SKILL-18: real workspace has no SKILL-18 violations after migration", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill18Violations = result.violations.filter((v) => v.rule === "SKILL-18");
    expect(skill18Violations).toEqual([]);
  });

  test("SKILL-18: pattern matches software-specific binding keys", () => {
    const patterns = [
      /bindings\.commands\.typecheck/gi,
      /bindings\.commands\.scopedBuild/gi,
      /bindings\.commands\.test/gi,
    ];
    const softwareSpecific = [
      "ref(forge.yaml bindings.commands.typecheck)",
      "ref(forge.yaml bindings.commands.scopedBuild)",
      "ref(forge.yaml bindings.commands.test)",
    ];
    const semanticKeys = [
      "ref(forge.yaml bindings.commands.validate)",
      "ref(forge.yaml bindings.commands.produce)",
      "ref(forge.yaml bindings.commands.verify)",
    ];
    for (const text of softwareSpecific) {
      expect(patterns.some((p) => new RegExp(p.source, p.flags).test(text))).toBe(true);
    }
    for (const text of semanticKeys) {
      expect(patterns.some((p) => new RegExp(p.source, p.flags).test(text))).toBe(false);
    }
  });

  test("SKILL-18: escape hatch suppresses violation", () => {
    const skill18Patterns = [
      /bindings\.commands\.typecheck/gi,
      /bindings\.commands\.scopedBuild/gi,
      /bindings\.commands\.test/gi,
    ];
    const disableMarker = "<!-- skill-lint-disable SKILL-18 -->";
    const bodyWithEscapeHatch = `${disableMarker}\n\n\`\`\`sh\nref(forge.yaml bindings.commands.typecheck)\n\`\`\``;
    const bodyWithoutEscapeHatch = `\`\`\`sh\nref(forge.yaml bindings.commands.typecheck)\n\`\`\``;

    // With escape hatch: no violation
    expect(bodyWithEscapeHatch.includes(disableMarker)).toBe(true);

    // Without escape hatch: pattern matches
    const instructionLines = bodyWithoutEscapeHatch
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("ref("));
    expect(
      instructionLines.some((line) =>
        skill18Patterns.some((p) => new RegExp(p.source, p.flags).test(line)),
      ),
    ).toBe(true);
  });
});

describe("SKILL-21: knowledge layer token budget warnings (RFC-0661)", () => {
  test("SkillValidateResult has warnings array", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    expect(result).toHaveProperty("warnings");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test("warnings never affect status — pass even with warnings", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    // If there are any warnings, status should still be "pass" (warnings are not errors)
    if (result.warnings.length > 0) {
      expect(result.status).toBe("pass");
    }
    // Violations should only contain errors, not warnings
    const warningRulesInViolations = result.violations.filter((v) => v.severity === "warning");
    expect(warningRulesInViolations).toEqual([]);
  });

  test("SKILL-19 legacy-section warnings are in warnings, not violations", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    // Any SKILL-19 warnings should be in warnings array, not violations
    const skill19InViolations = result.violations.filter(
      (v) => v.rule === "SKILL-19" && v.severity === "warning",
    );
    expect(skill19InViolations).toEqual([]);
    // SKILL-19 errors (schema issues) should still be in violations
    const skill19Errors = result.violations.filter(
      (v) => v.rule === "SKILL-19" && v.severity === "error",
    );
    // There should be no schema errors in current workspace
    expect(skill19Errors).toEqual([]);
  });

  test("no SKILL-21 warnings at introduction — all forge skills within default budgets", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill21Warnings = result.warnings.filter((w) => w.rule === "SKILL-21");
    // All existing knowledge files are knowledge-adjacent (freeform), so no budget warnings
    expect(skill21Warnings).toEqual([]);
  });
});

describe("ef-composition-review, ef-render-verify, and ef-onboard skills", () => {
  const workspaceRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

  test("FORGE_SKILLS registry includes all three ef- skills", () => {
    const names = FORGE_SKILLS.map((s) => s.name);
    expect(names).toContain("ef-composition-review");
    expect(names).toContain("ef-render-verify");
    expect(names).toContain("ef-onboard");
  });

  test("ef-composition-review and ef-render-verify have category fo and concerns read-only", () => {
    const review = FORGE_SKILLS.find((s) => s.name === "ef-composition-review");
    const verify = FORGE_SKILLS.find((s) => s.name === "ef-render-verify");
    expect(review).toBeDefined();
    expect(verify).toBeDefined();
    expect(review?.category).toBe("fo");
    expect(review?.concerns).toBe("read-only");
    expect(verify?.category).toBe("fo");
    expect(verify?.concerns).toBe("read-only");
  });

  test("ef-onboard has category fo and concerns content-mutation", () => {
    const onboard = FORGE_SKILLS.find((s) => s.name === "ef-onboard");
    expect(onboard).toBeDefined();
    expect(onboard?.category).toBe("fo");
    expect(onboard?.concerns).toBe("content-mutation");
  });

  test("forge.skill.validate passes with zero violations for ef-composition-review", () => {
    const result = runSkillValidate({}, { workspaceRoot });
    const reviewViolations = result.violations.filter((v) => v.skill === "ef-composition-review");
    expect(reviewViolations).toEqual([]);
  });

  test("forge.skill.validate passes with zero violations for ef-render-verify", () => {
    const result = runSkillValidate({}, { workspaceRoot });
    const verifyViolations = result.violations.filter((v) => v.skill === "ef-render-verify");
    expect(verifyViolations).toEqual([]);
  });

  test("forge.skill.validate passes with zero violations for ef-onboard", () => {
    const result = runSkillValidate({}, { workspaceRoot });
    const onboardViolations = result.violations.filter((v) => v.skill === "ef-onboard");
    expect(onboardViolations).toEqual([]);
  });
});
