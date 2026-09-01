import { test, expect, describe } from "vitest";
import {
  evaluateAcceptanceCriteria,
  computeProbeCoverage,
  type AddViolationFn,
  validateSingleRfc,
} from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testWorkspace = join(tmpdir(), "test-workspace-rfc0997");

function makeParsed(
  status: string,
  body: string,
  extraFm: Record<string, unknown> = {},
): ParsedRfc {
  return {
    frontmatter: {
      id: "RFC-9999",
      title: "Test RFC",
      status,
      kind: "command",
      scope: "workspace",
      owners: ["architecture"],
      createdAt: "2026-09-01",
      updatedAt: "2026-09-01",
      ...extraFm,
    },
    body,
  };
}

const BASE_BODY = `
# RFC-9999: Test RFC

## Context

Test context.

## Problem

Test problem.

## Decision

Test decision.

## Architectural fit

Test fit.

## Design

### CLI surface

Test CLI.

### TypeScript contracts

Test types.

### File system responsibilities

| Path | Role |
|---|---|
| \`test.ts\` | test |

### Output format

Test output.

### Failure modes

Test failures.

## Rollout

Test rollout.

## Alternatives considered

Test alternatives.

## Risks

Test risks.

## Acceptance criteria

ACCEPTANCE_HERE

## Implementation notes for agents

Test notes.
`;

function makeViolationsCollector(): {
  add: AddViolationFn;
  violations: { rfcId: string; rule: string; message: string; severity: string }[];
} {
  const violations: { rfcId: string; rule: string; message: string; severity: string }[] = [];
  const add: AddViolationFn = (rfcId, _file, rule, message, severity = "error") => {
    violations.push({ rfcId, rule, message, severity });
  };
  return { add, violations };
}

async function runValidate(
  parsed: ParsedRfc,
): Promise<{ rfcId: string; rule: string; message: string; severity: string }[]> {
  const { add, violations } = makeViolationsCollector();
  await validateSingleRfc(
    "rfc-9999-test.md",
    parsed,
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    new Set(Object.keys(parsed.frontmatter)),
    testWorkspace,
    add,
  );
  return violations;
}

function filterRule(
  violations: { rfcId: string; rule: string; message: string; severity: string }[],
  rule: string,
): { rfcId: string; rule: string; message: string; severity: string }[] {
  return violations.filter((v) => v.rule === rule);
}

// ─── evaluateAcceptanceCriteria: AC-N parsing ──────────────────────────────

describe("evaluateAcceptanceCriteria: AC-N id parsing (RFC-0997)", () => {
  test("parses AC-N ids from checklist lines", () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first criterion (evidence: test.ts:1)\n- [ ] AC-2: second criterion\n- [x] AC-3: third (evidence: test.ts:2)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.criterionIds).toEqual(["AC-1", "AC-2", "AC-3"]);
    expect(result.duplicateCriterionIds).toEqual([]);
    expect(result.linesWithoutId).toEqual([]);
  });

  test("detects duplicate AC-N ids", () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] AC-1: duplicate\n- [x] AC-2: third (evidence: test.ts:2)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.criterionIds).toEqual(["AC-1", "AC-2"]);
    expect(result.duplicateCriterionIds).toEqual(["AC-1"]);
  });

  test("detects checklist lines without AC-N prefix", () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] no id here\n- [x] AC-2: third (evidence: test.ts:2)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.linesWithoutId).toEqual(["- [ ] no id here"]);
  });
});

// ─── computeProbeCoverage ───────────────────────────────────────────────────

describe("computeProbeCoverage (RFC-0997)", () => {
  test("full coverage when all criteria have probes", () => {
    const ids = ["AC-1", "AC-2", "AC-3"];
    const acceptance = [
      { probe: "file-exists", path: "a.ts", criterion: "AC-1" },
      { probe: "file-exists", path: "b.ts", criterion: "AC-2" },
      { probe: "file-exists", path: "c.ts", criterion: "AC-3" },
    ];
    const report = computeProbeCoverage(ids, acceptance);
    expect(report.totalCriteria).toBe(3);
    expect(report.probeBackedCriteria).toBe(3);
    expect(report.coverageRatio).toBe(1);
    expect(report.uncoveredCriteria).toEqual([]);
    expect(report.unboundProbes).toEqual([]);
  });

  test("partial coverage when some criteria lack probes", () => {
    const ids = ["AC-1", "AC-2", "AC-3"];
    const acceptance = [
      { probe: "file-exists", path: "a.ts", criterion: "AC-1" },
      { probe: "file-exists", path: "b.ts", criterion: "AC-2" },
    ];
    const report = computeProbeCoverage(ids, acceptance);
    expect(report.totalCriteria).toBe(3);
    expect(report.probeBackedCriteria).toBe(2);
    expect(report.coverageRatio).toBeCloseTo(0.667, 2);
    expect(report.uncoveredCriteria).toEqual(["AC-3"]);
  });

  test("unbound probe references nonexistent criterion", () => {
    const ids = ["AC-1"];
    const acceptance = [
      { probe: "file-exists", path: "a.ts", criterion: "AC-1" },
      { probe: "file-exists", path: "b.ts", criterion: "AC-99" },
    ];
    const report = computeProbeCoverage(ids, acceptance);
    expect(report.unboundProbes).toEqual(["AC-99"]);
  });

  test("probe without criterion field is unbound", () => {
    const ids = ["AC-1"];
    const acceptance = [{ probe: "file-exists", path: "a.ts" }];
    const report = computeProbeCoverage(ids, acceptance);
    expect(report.unboundProbes).toEqual(["(missing)"]);
    expect(report.probeBackedCriteria).toBe(0);
  });

  test("zero criteria and zero probes gives ratio 0", () => {
    const report = computeProbeCoverage([], []);
    expect(report.totalCriteria).toBe(0);
    expect(report.coverageRatio).toBe(0);
  });
});

// ─── V-35: probe→criterion referential integrity ───────────────────────────

describe("V-35: probe→criterion referential integrity (RFC-0997)", () => {
  test("post-cutoff probe without criterion fires V-35", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] AC-2: second\n- [x] AC-3: third (evidence: test.ts:2)",
    );
    const parsed = makeParsed("accepted", body, {
      acceptance: [{ probe: "file-exists", path: "a.ts" }],
    });
    const violations = await runValidate(parsed);
    const v35 = filterRule(violations, "V-35");
    expect(v35.length).toBeGreaterThanOrEqual(1);
    expect(v35[0]!.message).toContain('lacks required "criterion"');
  });

  test("post-cutoff probe with nonexistent criterion fires V-35", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] AC-2: second\n- [x] AC-3: third (evidence: test.ts:2)",
    );
    const parsed = makeParsed("accepted", body, {
      acceptance: [{ probe: "file-exists", path: "a.ts", criterion: "AC-99" }],
    });
    const violations = await runValidate(parsed);
    const v35 = filterRule(violations, "V-35");
    expect(v35.length).toBeGreaterThanOrEqual(1);
    expect(v35[0]!.message).toContain("does not exist");
  });

  test("post-cutoff probe with valid criterion does NOT fire V-35", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] AC-2: second\n- [x] AC-3: third (evidence: test.ts:2)",
    );
    const parsed = makeParsed("accepted", body, {
      acceptance: [{ probe: "file-exists", path: "a.ts", criterion: "AC-1" }],
    });
    const violations = await runValidate(parsed);
    const v35 = filterRule(violations, "V-35");
    expect(v35).toHaveLength(0);
  });

  test("pre-cutoff probe without criterion does NOT fire V-35", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] AC-2: second\n- [x] AC-3: third (evidence: test.ts:2)",
    );
    const parsed = makeParsed("accepted", body, {
      createdAt: "2026-01-01",
      acceptance: [{ probe: "file-exists", path: "a.ts" }],
    });
    const violations = await runValidate(parsed);
    const v35 = filterRule(violations, "V-35");
    expect(v35).toHaveLength(0);
  });
});

// ─── V-36: criterion identifier discipline ─────────────────────────────────

describe("V-36: criterion identifier discipline (RFC-0997)", () => {
  test("post-cutoff line without AC-N fires V-36", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] no id here\n- [x] AC-3: third (evidence: test.ts:2)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v36 = filterRule(violations, "V-36");
    expect(v36.length).toBeGreaterThanOrEqual(1);
    expect(v36[0]!.message).toContain("lacks");
  });

  test("post-cutoff duplicate AC-N fires V-36", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] AC-1: dup\n- [x] AC-2: third (evidence: test.ts:2)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v36 = filterRule(violations, "V-36");
    expect(v36.length).toBeGreaterThanOrEqual(1);
    expect(v36[0]!.message).toContain("duplicate");
  });

  test("pre-cutoff line without AC-N does NOT fire V-36", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test.ts:1)\n- [ ] no id here\n- [x] AC-3: third (evidence: test.ts:2)",
    );
    const parsed = makeParsed("accepted", body, { createdAt: "2026-01-01" });
    const violations = await runValidate(parsed);
    const v36 = filterRule(violations, "V-36");
    expect(v36).toHaveLength(0);
  });
});

// ─── V-37: evidence mechanism validity ─────────────────────────────────────

describe("V-37: evidence mechanism validity (RFC-0997)", () => {
  test("post-cutoff probe:AC-N with no probe fires V-37", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: probe:AC-1)\n- [ ] AC-2: second\n- [x] AC-3: third (evidence: probe:AC-3)",
    );
    const parsed = makeParsed("accepted", body, {
      acceptance: [],
    });
    const violations = await runValidate(parsed);
    const v37 = filterRule(violations, "V-37");
    expect(v37.length).toBeGreaterThanOrEqual(1);
    expect(v37[0]!.message).toContain("no bound probe");
  });

  test("post-cutoff probe:AC-N referencing nonexistent criterion fires V-37", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: probe:AC-99)\n- [ ] AC-2: second\n- [x] AC-3: third (evidence: probe:AC-3)",
    );
    const parsed = makeParsed("accepted", body, {
      acceptance: [],
    });
    const violations = await runValidate(parsed);
    const v37 = filterRule(violations, "V-37");
    expect(v37.length).toBeGreaterThanOrEqual(1);
    expect(v37[0]!.message).toContain("does not exist");
  });

  test("post-cutoff test:path with missing file fires V-37", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: test:nonexistent/file.ts)\n- [ ] AC-2: second\n- [x] AC-3: third (evidence: test:nonexistent/file2.ts)",
    );
    const parsed = makeParsed("accepted", body, {
      acceptance: [],
    });
    const violations = await runValidate(parsed);
    const v37 = filterRule(violations, "V-37");
    expect(v37.length).toBeGreaterThanOrEqual(1);
    expect(v37[0]!.message).toContain("does not exist");
  });

  test("pre-cutoff does NOT fire V-37", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: first (evidence: probe:AC-99)\n- [ ] AC-2: second\n- [x] AC-3: third (evidence: probe:AC-99)",
    );
    const parsed = makeParsed("accepted", body, {
      createdAt: "2026-01-01",
      acceptance: [],
    });
    const violations = await runValidate(parsed);
    const v37 = filterRule(violations, "V-37");
    expect(v37).toHaveLength(0);
  });
});

// ─── V-37: null-safety guard (no acceptance section) ───────────────────────

describe("V-37: null-safety when no acceptance criteria section (RFC-0997)", () => {
  test("post-cutoff RFC with no acceptance section does not crash", async () => {
    const body = BASE_BODY.replace("## Acceptance criteria\n\nACCEPTANCE_HERE\n", "");
    const parsed = makeParsed("accepted", body, {
      acceptance: [{ probe: "file-exists", path: "a.ts", criterion: "AC-1" }],
    });
    const violations = await runValidate(parsed);
    expect(violations).toBeDefined();
  });
});
