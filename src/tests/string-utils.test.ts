/*
<MODULE_CONTRACT>
<purpose>
Unit tests for string utils covering toKebabCase. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the string suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { toKebabCase } from "../utils/string-utils.ts";

describe("toKebabCase", () => {
  test("lowercases simple input", () => {
    expect(toKebabCase("Hello")).toBe("hello");
  });

  test("replaces spaces with hyphens", () => {
    expect(toKebabCase("hello world")).toBe("hello-world");
  });

  test("replaces non-alphanumeric with hyphens", () => {
    expect(toKebabCase("hello_world")).toBe("hello-world");
    expect(toKebabCase("hello.world")).toBe("hello-world");
    expect(toKebabCase("hello@world!")).toBe("hello-world");
  });

  test("strips leading/trailing hyphens", () => {
    expect(toKebabCase("--hello--")).toBe("hello");
    expect(toKebabCase("  hello  ")).toBe("hello");
  });

  test("collapses multiple separators", () => {
    expect(toKebabCase("hello   world")).toBe("hello-world");
    expect(toKebabCase("hello___world")).toBe("hello-world");
  });

  test("empty string stays empty", () => {
    expect(toKebabCase("")).toBe("");
  });

  test("all-symbols string becomes empty", () => {
    expect(toKebabCase("---")).toBe("");
    expect(toKebabCase("@#$%")).toBe("");
  });

  test("preserves digits", () => {
    expect(toKebabCase("hello123")).toBe("hello123");
    expect(toKebabCase("hello 123 world")).toBe("hello-123-world");
  });
});
