import { test, expect, describe } from "vitest";
import { validateSingleRfc, type AddViolationFn } from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";

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
      kind: "policy",
      scope: "workspace",
      owners: ["architecture"],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
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
    "/tmp/test-workspace",
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

describe("V-26: implemented RFCs must have all acceptance criteria checked", () => {
  test("error when implemented with unchecked criteria", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] done criterion (evidence: test.ts:1)\n- [ ] undone criterion\n- [x] another done (evidence: test.ts:2)",
    );
    const parsed = makeParsed("implemented", body);
    const violations = await runValidate(parsed);
    const v26 = filterRule(violations, "V-26");
    expect(v26).toHaveLength(1);
    expect(v26[0]!.message).toContain("1 acceptance criteria are unchecked");
  });

  test("no V-26 error when implemented with all checked", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] done (evidence: test.ts:1)\n- [x] another (evidence: test.ts:2)\n- [x] third (evidence: test.ts:3)",
    );
    const parsed = makeParsed("implemented", body);
    const violations = await runValidate(parsed);
    const v26 = filterRule(violations, "V-26");
    expect(v26).toHaveLength(0);
  });

  test("no V-26 error when accepted with unchecked criteria", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] done (evidence: test.ts:1)\n- [ ] undone\n- [x] another (evidence: test.ts:2)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v26 = filterRule(violations, "V-26");
    expect(v26).toHaveLength(0);
  });

  test("no V-26 error when draft with unchecked criteria", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] done (evidence: test.ts:1)\n- [ ] undone\n- [x] another (evidence: test.ts:2)",
    );
    const parsed = makeParsed("draft", body);
    const violations = await runValidate(parsed);
    const v26 = filterRule(violations, "V-26");
    expect(v26).toHaveLength(0);
  });
});

describe("V-27: checked criteria must carry inline evidence", () => {
  test("no error when [x] has evidence", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] done (evidence: test.ts:1)\n- [x] another (evidence: test.ts:2)\n- [x] third (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v27 = filterRule(violations, "V-27");
    expect(v27).toHaveLength(0);
  });

  test("error when [x] lacks evidence", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] done without evidence\n- [x] another (evidence: test.ts:2)\n- [x] third (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v27 = filterRule(violations, "V-27");
    expect(v27).toHaveLength(1);
    expect(v27[0]!.message).toContain("done without evidence");
  });

  test("no V-27 error for unchecked [ ] without evidence", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [ ] unchecked without evidence\n- [x] done (evidence: test.ts:2)\n- [x] third (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v27 = filterRule(violations, "V-27");
    expect(v27).toHaveLength(0);
  });

  test("no V-27 error for indented sub-items without evidence", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] parent (evidence: test.ts:1)\n  - [x] sub-item without evidence\n- [x] another (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v27 = filterRule(violations, "V-27");
    expect(v27).toHaveLength(0);
  });
});

describe("V-31: filename-number uniqueness and filename/id consistency", () => {
  test("no V-31 error when filename number matches frontmatter id", async () => {
    const parsed = makeParsed("accepted", BASE_BODY);
    const { add, violations } = makeViolationsCollector();
    const seenFilenameNumbers = new Map<number, string>();
    await validateSingleRfc(
      "rfc-9999-test.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      "/tmp/test-workspace",
      add,
      seenFilenameNumbers,
    );
    const v31 = filterRule(violations, "V-31");
    expect(v31).toHaveLength(0);
  });

  test("V-31 error when filename number does not match frontmatter id", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, { id: "RFC-0488" });
    const { add, violations } = makeViolationsCollector();
    const seenFilenameNumbers = new Map<number, string>();
    await validateSingleRfc(
      "rfc-0490-foo.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      "/tmp/test-workspace",
      add,
      seenFilenameNumbers,
    );
    const v31 = filterRule(violations, "V-31");
    expect(v31).toHaveLength(1);
    expect(v31[0]!.message).toContain(
      "Filename number 0490 does not match frontmatter id RFC-0488",
    );
  });

  test("V-31 error when duplicate filename number found", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, { id: "RFC-0490" });
    const { add, violations } = makeViolationsCollector();
    const seenFilenameNumbers = new Map<number, string>([[490, "docs/rfcs/rfc-0490-foo.md"]]);
    await validateSingleRfc(
      "rfc-0490-bar.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      "/tmp/test-workspace",
      add,
      seenFilenameNumbers,
    );
    const v31 = filterRule(violations, "V-31");
    expect(v31).toHaveLength(1);
    expect(v31[0]!.message).toContain("Duplicate filename number 0490");
  });

  test("no V-31 error when seenFilenameNumbers is not passed", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, { id: "RFC-0488" });
    const { add, violations } = makeViolationsCollector();
    await validateSingleRfc(
      "rfc-0490-foo.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      "/tmp/test-workspace",
      add,
    );
    const v31 = filterRule(violations, "V-31");
    expect(v31).toHaveLength(0);
  });
});
