import { test, expect, describe } from "vitest";
import { skillFrontmatterSchema } from "../skill-schema.ts";

describe("skillFrontmatterSchema", () => {
  const valid = {
    name: "fo-idea",
    description: "Analyze a user's idea and route to the appropriate pipeline.",
    invocation: "user",
    category: "fo",
    concerns: "document-only",
    dependsOn: ["my-preferences"],
    languagePolicy: "ref(PREFERENCES.md)",
  };

  test("accepts a valid frontmatter", () => {
    const result = skillFrontmatterSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("defaults dependsOn to empty array", () => {
    const { dependsOn: _, ...withoutDeps } = valid;
    const result = skillFrontmatterSchema.safeParse(withoutDeps);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependsOn).toEqual([]);
    }
  });

  test("rejects empty name", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  test("rejects empty description", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, description: "" }).success).toBe(false);
  });

  test("rejects description over 200 chars", () => {
    expect(
      skillFrontmatterSchema.safeParse({ ...valid, description: "x".repeat(201) }).success,
    ).toBe(false);
  });

  test("accepts description of exactly 200 chars", () => {
    expect(
      skillFrontmatterSchema.safeParse({ ...valid, description: "x".repeat(200) }).success,
    ).toBe(true);
  });

  test("rejects invalid invocation", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, invocation: "auto" }).success).toBe(false);
  });

  test("rejects invalid category", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, category: "other" }).success).toBe(false);
  });

  test("rejects invalid concerns", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, concerns: "hybrid" }).success).toBe(false);
  });

  test("rejects legacy implementation concerns value", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, concerns: "implementation" }).success).toBe(
      false,
    );
  });

  test("accepts read-only concerns", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, concerns: "read-only" }).success).toBe(
      true,
    );
  });

  test("accepts content-mutation concerns", () => {
    expect(
      skillFrontmatterSchema.safeParse({ ...valid, concerns: "content-mutation" }).success,
    ).toBe(true);
  });

  test("accepts code-mutation concerns", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, concerns: "code-mutation" }).success).toBe(
      true,
    );
  });

  test("rejects invalid languagePolicy", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, languagePolicy: "en" }).success).toBe(
      false,
    );
  });

  test("accepts optional bindings field", () => {
    const result = skillFrontmatterSchema.safeParse({
      ...valid,
      bindings: {
        requires: ["commands.validateRfc"],
        optional: ["paths.invariantsFile"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bindings?.requires).toEqual(["commands.validateRfc"]);
      expect(result.data.bindings?.optional).toEqual(["paths.invariantsFile"]);
    }
  });

  test("accepts bindings with empty requires and optional", () => {
    const result = skillFrontmatterSchema.safeParse({
      ...valid,
      bindings: { requires: [], optional: [] },
    });
    expect(result.success).toBe(true);
  });

  test("accepts frontmatter without bindings field", () => {
    const result = skillFrontmatterSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bindings).toBeUndefined();
    }
  });

  test("accepts optional knowledge field", () => {
    const result = skillFrontmatterSchema.safeParse({
      ...valid,
      knowledge: ["qa-log.md", "learned-principles.md"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toEqual(["qa-log.md", "learned-principles.md"]);
    }
  });

  test("accepts frontmatter without knowledge field", () => {
    const result = skillFrontmatterSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.knowledge).toBeUndefined();
    }
  });

  test("rejects non-array knowledge", () => {
    expect(skillFrontmatterSchema.safeParse({ ...valid, knowledge: "qa-log.md" }).success).toBe(
      false,
    );
  });
});
