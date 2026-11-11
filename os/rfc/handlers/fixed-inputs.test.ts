/*
<MODULE_CONTRACT>
<purpose>RFC-1569 — V-50 containment compares each fixed-input literal
  against the regex-UNESCAPED probe pattern (escaped metachar literals keep
  coverage).</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1569: V-50 unescape-before-containment tests (AC-9)</item>
  <item>RFC-1569: lint rfc evidence annotations and transient probe targets</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { evaluateFixedInputs } from "./fixed-inputs.ts";

const body = (value: string): string =>
  `## Fixed inputs\n\n| ID | Value | Source | Checked by |\n| --- | --- | --- | --- |\n| FI-1 | ${value} | decision | AC-1 |\n`;

describe("V-50: regex-unescaped containment (RFC-1569)", () => {
  test("AC-9: escaped \\$\\{WORKSPACE_ROOT\\} pattern covers the literal", () => {
    const diags = evaluateFixedInputs(
      body("`${WORKSPACE_ROOT}`"),
      ["AC-1"],
      [
        {
          probe: "file-contains",
          criterion: "AC-1",
          path: "x",
          pattern: "\\$\\{WORKSPACE_ROOT\\}",
        } as never,
      ],
    );
    expect(diags.filter((d) => d.message.includes("not contained"))).toEqual([]);
  });

  test("unescaped metachars in a literal still report uncovered", () => {
    const diags = evaluateFixedInputs(
      body("`${WORKSPACE_ROOT}`"),
      ["AC-1"],
      [
        {
          probe: "file-contains",
          criterion: "AC-1",
          path: "x",
          pattern: "literal plain text",
        } as never,
      ],
    );
    expect(diags.some((d) => d.message.includes("not contained"))).toBe(true);
  });

  test("dotted literal covered by escaped a\\.b pattern", () => {
    const diags = evaluateFixedInputs(
      body("`a.b`"),
      ["AC-1"],
      [
        {
          probe: "file-contains",
          criterion: "AC-1",
          path: "x",
          pattern: "a\\.b",
        } as never,
      ],
    );
    expect(diags.filter((d) => d.message.includes("not contained"))).toEqual([]);
  });
});
