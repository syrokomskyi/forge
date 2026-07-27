import { test, expect, describe } from "vitest";
import { FORGE_SKILLS } from "../registry.ts";

describe("FORGE_SKILLS registry", () => {
  test("is non-empty", () => {
    expect(FORGE_SKILLS.length).toBeGreaterThan(10);
  });

  test("has no duplicate names", () => {
    const names = FORGE_SKILLS.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test("has no duplicate paths", () => {
    const paths = FORGE_SKILLS.map((s) => s.path);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  test("all names are kebab-case", () => {
    for (const skill of FORGE_SKILLS) {
      expect(skill.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  test("all paths end with SKILL.md", () => {
    for (const skill of FORGE_SKILLS) {
      expect(skill.path.endsWith("SKILL.md")).toBe(true);
    }
  });

  test("all categories are valid", () => {
    const validCategories = new Set(["fo", "shared", "meta"]);
    for (const skill of FORGE_SKILLS) {
      expect(validCategories.has(skill.category)).toBe(true);
    }
  });

  test("all invocations are valid", () => {
    const validInvocations = new Set(["user", "model"]);
    for (const skill of FORGE_SKILLS) {
      expect(validInvocations.has(skill.invocation)).toBe(true);
    }
  });

  test("all concerns are valid", () => {
    const validConcerns = new Set([
      "read-only",
      "document-only",
      "content-mutation",
      "code-mutation",
    ]);
    for (const skill of FORGE_SKILLS) {
      expect(validConcerns.has(skill.concerns)).toBe(true);
    }
  });

  test("dependsOn entries reference existing skill names", () => {
    const knownNames = new Set(FORGE_SKILLS.map((s) => s.name));
    for (const skill of FORGE_SKILLS) {
      for (const dep of skill.dependsOn) {
        expect(knownNames.has(dep)).toBe(true);
      }
    }
  });

  test("path prefix matches category directory", () => {
    for (const skill of FORGE_SKILLS) {
      expect(skill.path.startsWith(`skills/${skill.category}/`)).toBe(true);
    }
  });
});
