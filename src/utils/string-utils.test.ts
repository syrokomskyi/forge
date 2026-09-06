// @vitest-environment node

import { describe, expect, it } from "vitest";

import { toKebabCase } from "./string-utils.ts";

describe("toKebabCase", () => {
  it("converts spaces to hyphens", () => {
    expect(toKebabCase("hello world")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(toKebabCase("hello!@#world")).toBe("hello-world");
  });

  it("trims leading and trailing hyphens", () => {
    expect(toKebabCase("---hello---")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(toKebabCase("")).toBe("");
  });
});
