/*
<MODULE_CONTRACT>
<purpose>RFC-1569 — V-PROBE-META-01 extension: mid-pattern anchors and
  unescaped brace/bracket arms over collectProbeMetacharHits.</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1569: metachar extension tests (AC-8) + suppression regression</item>
  <item>RFC-1569: lint rfc evidence annotations and transient probe targets</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { collectProbeMetacharHits } from "./validate-rules.ts";

const fm = (pattern: string): string =>
  `acceptance:\n  - probe: file-contains\n    criterion: AC-1\n    path: x\n    pattern: "${pattern}"\n`;

const probe = (pattern: string) => [
  { probe: "file-contains", criterion: "AC-1", path: "x", pattern },
];

describe("V-PROBE-META-01 extensions (RFC-1569)", () => {
  test("AC-8: mid-pattern unescaped $ is flagged", () => {
    const hits = collectProbeMetacharHits(probe("${WORKSPACE_ROOT}"), fm(""));
    expect(hits.some((h) => h.chars.some((c) => c.includes("`$`")))).toBe(true);
  });

  test("leading ^ and trailing $ anchors stay clean", () => {
    const hits = collectProbeMetacharHits(probe("^hero end$"), fm(""));
    expect(hits).toEqual([]);
  });

  test("mid-pattern unescaped ^ is flagged", () => {
    const hits = collectProbeMetacharHits(probe("a^b"), fm(""));
    expect(hits.some((h) => h.chars.some((c) => c.includes("`^`")))).toBe(true);
  });

  test("escaped \\$ and \\^ stay clean", () => {
    const hits = collectProbeMetacharHits(probe("a\\$b\\^c"), fm(""));
    expect(hits).toEqual([]);
  });

  test("unescaped {} and [] are flagged", () => {
    const brace = collectProbeMetacharHits(probe("a{1,2}"), fm(""));
    expect(brace.some((h) => h.chars.some((c) => c.includes("`{`/`}`")))).toBe(true);
    const bracket = collectProbeMetacharHits(probe("a[bc]"), fm(""));
    expect(bracket.some((h) => h.chars.some((c) => c.includes("`[`/`]`")))).toBe(true);
  });

  test("escaped \\{\\} and \\[\\] stay clean", () => {
    const hits = collectProbeMetacharHits(probe("a\\{1\\}b\\[x\\]"), fm(""));
    expect(hits).toEqual([]);
  });

  test("suggestion escapes the newly flagged characters", () => {
    const hits = collectProbeMetacharHits(probe("a{b}c[d]e$f"), fm(""));
    const s = hits[0]?.suggestion ?? "";
    expect(s).not.toMatch(/(?<!\\)[{[\]]/);
    expect(s).toContain("\\$");
  });

  test("probe-meta: intentional marker still suppresses", () => {
    const pattern = "${WORKSPACE_ROOT}";
    const fmWithMarker = `acceptance:\n  - probe: file-contains\n    criterion: AC-1\n    path: x\n    pattern: "${pattern}"  # <!-- probe-meta: intentional -->\n`;
    const hits = collectProbeMetacharHits(probe(pattern), fmWithMarker);
    expect(hits).toEqual([]);
  });
});
