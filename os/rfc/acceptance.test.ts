/*
<MODULE_CONTRACT>
<purpose>
Unit tests for acceptance covering validateAcceptanceShape — RFC-1271 optional probe metadata; V-43 — verificationTier enum validation (RFC-1271).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the acceptance suite's contract for test-file scaffold coverage.</item>
  <item>RFC-1334: step 4 — reachable acceptance probe (symbol and command modes) and V-45</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateAcceptanceShape } from "./acceptance.ts";
import { validateSingleRfc, type AddViolationFn } from "./handlers/validate-rules.ts";
import type { ParsedRfc } from "./frontmatter-io.ts";

describe("validateAcceptanceShape — RFC-1271 optional probe metadata", () => {
  const baseProbe = { probe: "file-contains", path: "x.md", pattern: "y" };

  test("accepts all four expectationSource values", () => {
    for (const expectationSource of ["self", "requirement", "independent", "external"]) {
      const issues = validateAcceptanceShape([{ ...baseProbe, expectationSource }]);
      expect(issues, `expectationSource=${expectationSource}`).toEqual([]);
    }
  });

  test("rejects an unknown expectationSource value", () => {
    const issues = validateAcceptanceShape([{ ...baseProbe, expectationSource: "operator" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.index).toBe(0);
    expect(issues[0]!.message).toContain("expectationSource");
  });

  test("rejects a non-string expectationSource", () => {
    const issues = validateAcceptanceShape([{ ...baseProbe, expectationSource: 42 }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("expectationSource");
  });

  test("accepts a string limitations field", () => {
    const issues = validateAcceptanceShape([
      { ...baseProbe, limitations: "covers exit code only, not output semantics" },
    ]);
    expect(issues).toEqual([]);
  });

  test("rejects a non-string limitations field", () => {
    const issues = validateAcceptanceShape([{ ...baseProbe, limitations: ["a", "b"] }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("limitations");
  });

  test("fields apply to every probe kind, not just the first", () => {
    const issues = validateAcceptanceShape([
      baseProbe,
      { probe: "file-exists", path: "x.md", expectationSource: "bogus" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.index).toBe(1);
  });

  test("absent fields stay valid", () => {
    expect(validateAcceptanceShape([baseProbe])).toEqual([]);
    expect(validateAcceptanceShape(undefined)).toEqual([]);
  });
});

describe("V-43 — verificationTier enum validation (RFC-1271)", () => {
  const makeParsed = (verificationTier?: string): ParsedRfc => ({
    frontmatter: {
      id: "RFC-9999",
      title: "Test RFC",
      status: "draft",
      kind: "policy",
      scope: "workspace",
      owners: ["architecture"],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      ...(verificationTier === undefined ? {} : { verificationTier }),
    },
    body: "# RFC-9999: Test RFC\n",
  });

  const runValidate = async (parsed: ParsedRfc) => {
    const violations: { rule: string }[] = [];
    const add: AddViolationFn = (_id, _file, rule) => void violations.push({ rule });
    await validateSingleRfc(
      "rfc-9999-test.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      join(tmpdir(), "test-workspace"),
      add,
    );
    return violations;
  };

  test("accepts all three tier values", async () => {
    for (const verificationTier of ["standard", "high", "formal"]) {
      const violations = await runValidate(makeParsed(verificationTier));
      expect(
        violations.filter((v) => v.rule === "V-43"),
        `verificationTier=${verificationTier}`,
      ).toEqual([]);
    }
  });

  test("accepts absent verificationTier", async () => {
    const violations = await runValidate(makeParsed());
    expect(violations.filter((v) => v.rule === "V-43")).toEqual([]);
  });

  test("rejects an unknown tier value", async () => {
    const violations = await runValidate(makeParsed("extreme"));
    expect(violations.some((v) => v.rule === "V-43")).toBe(true);
  });
  test("rejects a reachable probe that declares both or neither of symbol and command", () => {
    const both = validateAcceptanceShape([
      { probe: "reachable", symbol: "a", module: "m.ts", command: "x.y" },
    ]);
    const neither = validateAcceptanceShape([{ probe: "reachable" }]);
    const ok = validateAcceptanceShape([{ probe: "reachable", command: "x.y" }]);
    expect(both).toHaveLength(1);
    expect(neither).toHaveLength(1);
    expect(ok).toEqual([]);
  });
});
