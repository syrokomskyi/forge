/*
<MODULE_CONTRACT>
<purpose>
Unit tests for string utils covering toKebabCase. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Fixtures stay inline and minimal so each case states its own setup.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the string suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

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
