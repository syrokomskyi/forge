/*
<MODULE_CONTRACT>
<purpose>
Unit tests for acceptance criteria covering extractAcceptanceCriteriaSection; evaluateAcceptanceCriteria. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the acceptance suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  evaluateAcceptanceCriteria,
  extractAcceptanceCriteriaSection,
} from "../../os/rfc/handlers/validate-rules.ts";

const BODY_WITH_SECTION = `# RFC-0001: Test

## Context

Some context.

## Acceptance criteria

- [x] First criterion (evidence: src/foo.ts:10, unit test)
- [x] Second criterion (evidence: src/bar.ts:20, integration test)
- [ ] Third criterion

## Risks

None.
`;

const BODY_NO_SECTION = `# RFC-0001: Test

## Context

No acceptance criteria section here.
`;

const BODY_ALL_CHECKED_WITH_EVIDENCE = `# RFC-0001: Test

## Acceptance criteria

- [x] First (evidence: src/a.ts:1, test)
- [x] Second (evidence: src/b.ts:2, test)

## Risks

None.
`;

const BODY_CHECKED_WITHOUT_EVIDENCE = `# RFC-0001: Test

## Acceptance criteria

- [x] First criterion without evidence
- [x] Second (evidence: src/b.ts:2, test)

## Risks

None.
`;

describe("extractAcceptanceCriteriaSection", () => {
  it("extracts the section text when present", () => {
    const section = extractAcceptanceCriteriaSection(BODY_WITH_SECTION);
    expect(section).toBeDefined();
    expect(section).toContain("- [x] First criterion");
    expect(section).toContain("- [ ] Third criterion");
  });

  it("returns undefined when section is absent", () => {
    const section = extractAcceptanceCriteriaSection(BODY_NO_SECTION);
    expect(section).toBeUndefined();
  });
});

describe("evaluateAcceptanceCriteria", () => {
  it("counts checked and unchecked criteria", () => {
    const result = evaluateAcceptanceCriteria(BODY_WITH_SECTION);
    expect(result.totalChecked).toBe(2);
    expect(result.totalUnchecked).toBe(1);
    expect(result.uncheckedLines).toHaveLength(1);
    expect(result.uncheckedLines[0]).toBe("- [ ] Third criterion");
  });

  it("returns zeros when section is absent", () => {
    const result = evaluateAcceptanceCriteria(BODY_NO_SECTION);
    expect(result.totalChecked).toBe(0);
    expect(result.totalUnchecked).toBe(0);
    expect(result.uncheckedLines).toEqual([]);
    expect(result.checkedWithoutEvidence).toEqual([]);
  });

  it("detects checked criteria without evidence", () => {
    const result = evaluateAcceptanceCriteria(BODY_CHECKED_WITHOUT_EVIDENCE);
    expect(result.totalChecked).toBe(2);
    expect(result.checkedWithoutEvidence).toHaveLength(1);
    expect(result.checkedWithoutEvidence[0]).toContain("First criterion without evidence");
  });

  it("returns empty checkedWithoutEvidence when all have evidence", () => {
    const result = evaluateAcceptanceCriteria(BODY_ALL_CHECKED_WITH_EVIDENCE);
    expect(result.totalChecked).toBe(2);
    expect(result.totalUnchecked).toBe(0);
    expect(result.checkedWithoutEvidence).toEqual([]);
  });
});
