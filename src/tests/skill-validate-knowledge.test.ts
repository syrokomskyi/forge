import { test, expect, describe } from "vitest";
import { runSkillValidate } from "../validators/skill-validate.ts";

describe("RFC-0660: SKILL-19/SKILL-20 validation", () => {
  test("SKILL-19: zero violations on real workspace after migration", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill19Violations = result.violations.filter((v) => v.rule === "SKILL-19");
    expect(skill19Violations).toEqual([]);
  });

  test("SKILL-20: zero violations on real workspace after migration", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const skill20Violations = result.violations.filter((v) => v.rule === "SKILL-20");
    expect(skill20Violations).toEqual([]);
  });

  test("SKILL-19/SKILL-20: knowledge-adjacent files produce no violations", () => {
    const result = runSkillValidate({}, { workspaceRoot: process.cwd() });
    const knowledgeViolations = result.violations.filter(
      (v) => v.rule === "SKILL-19" || v.rule === "SKILL-20",
    );
    // forge-bootstrap has knowledge-adjacent files (forge-about.md, etc.)
    // These should produce zero SKILL-19/SKILL-20 violations
    expect(knowledgeViolations).toEqual([]);
  });
});
