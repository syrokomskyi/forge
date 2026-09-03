import { test, expect, describe } from "vitest";
import {
  evaluateAcceptanceCriteria,
  evaluateDocumentReadiness,
  type AddViolationFn,
  validateSingleRfc,
} from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testWorkspace = join(tmpdir(), "test-workspace-rfc1006");

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
      createdAt: "2026-09-03",
      updatedAt: "2026-09-03",
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

DOCUMENT_READINESS_HERE

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

// ─── evaluateDocumentReadiness ─────────────────────────────────────────────

describe("evaluateDocumentReadiness (RFC-1006)", () => {
  test("returns empty when no Document readiness section", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: test (evidence: test.ts:1)",
    );
    const result = evaluateDocumentReadiness(body);
    expect(result.totalChecked).toBe(0);
    expect(result.totalUnchecked).toBe(0);
    expect(result.criterionIds).toEqual([]);
  });

  test("parses DR-N ids and checked/unchecked items", () => {
    const body = BASE_BODY.replace(
      "DOCUMENT_READINESS_HERE",
      "## Document readiness\n\n- [x] DR-1: alternatives listed (evidence: file: test.md:1)\n- [ ] DR-2: reversibility stated",
    ).replace("ACCEPTANCE_HERE", "- [x] AC-1: test (evidence: test.ts:1)");
    const result = evaluateDocumentReadiness(body);
    expect(result.totalChecked).toBe(1);
    expect(result.totalUnchecked).toBe(1);
    expect(result.criterionIds).toEqual(["DR-1", "DR-2"]);
    expect(result.uncheckedLines).toHaveLength(1);
  });
});

// ─── V-38: document readiness completeness ──────────────────────────────────

describe("V-38: document readiness completeness (RFC-1006)", () => {
  test("fires for accepted post-cutoff RFC with unchecked DR items", async () => {
    const body = BASE_BODY.replace(
      "DOCUMENT_READINESS_HERE",
      "## Document readiness\n\n- [ ] DR-1: alternatives listed",
    ).replace("ACCEPTANCE_HERE", "- [x] AC-1: test (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)");
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v38 = filterRule(violations, "V-38");
    expect(v38).toHaveLength(1);
    expect(v38[0]!.message).toContain("1 document readiness criteria are unchecked");
  });

  test("does not fire when all DR items are checked", async () => {
    const body = BASE_BODY.replace(
      "DOCUMENT_READINESS_HERE",
      "## Document readiness\n\n- [x] DR-1: alternatives listed (evidence: file: test.md:1)",
    ).replace("ACCEPTANCE_HERE", "- [x] AC-1: test (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)");
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v38 = filterRule(violations, "V-38");
    expect(v38).toHaveLength(0);
  });

  test("does not fire for pre-cutoff RFCs", async () => {
    const body = BASE_BODY.replace(
      "DOCUMENT_READINESS_HERE",
      "## Document readiness\n\n- [ ] DR-1: alternatives listed",
    ).replace("ACCEPTANCE_HERE", "- [x] AC-1: test (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)");
    const parsed = makeParsed("accepted", body, { createdAt: "2026-08-01" });
    const violations = await runValidate(parsed);
    const v38 = filterRule(violations, "V-38");
    expect(v38).toHaveLength(0);
  });

  test("does not fire for draft RFCs (warning only)", async () => {
    const body = BASE_BODY.replace(
      "DOCUMENT_READINESS_HERE",
      "## Document readiness\n\n- [ ] DR-1: alternatives listed",
    ).replace("ACCEPTANCE_HERE", "- [x] AC-1: test (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)");
    const parsed = makeParsed("draft", body);
    const violations = await runValidate(parsed);
    const v38 = filterRule(violations, "V-38");
    expect(v38).toHaveLength(0);
  });
});

// ─── V-39: non-atomic criterion ────────────────────────────────────────────

describe("V-39: non-atomic criterion (RFC-1006)", () => {
  test("detects SHALL ... and <verb> pattern", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL validate input and persist results (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.nonAtomicViolations).toHaveLength(1);
    expect(result.nonAtomicViolations[0]!.acId).toBe("AC-1");
  });

  test("does not fire for single-verb criteria", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL validate input (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.nonAtomicViolations).toHaveLength(0);
  });

  test("does not fire for 'and' inside noun phrases", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL process input and output streams (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    // "streams" is not in the verb list, so this should not fire
    expect(result.nonAtomicViolations).toHaveLength(0);
  });

  test("fires as error for accepted post-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL validate input and persist results (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v39 = filterRule(violations, "V-39");
    expect(v39).toHaveLength(1);
    expect(v39[0]!.severity).toBe("error");
  });

  test("fires as warning for draft post-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL validate input and persist results (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("draft", body);
    const violations = await runValidate(parsed);
    const v39 = filterRule(violations, "V-39");
    expect(v39).toHaveLength(1);
    expect(v39[0]!.severity).toBe("warning");
  });

  test("does not fire for pre-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL validate input and persist results (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body, { createdAt: "2026-08-01" });
    const violations = await runValidate(parsed);
    const v39 = filterRule(violations, "V-39");
    expect(v39).toHaveLength(0);
  });
});

// ─── V-40: unbounded quantity ──────────────────────────────────────────────

describe("V-40: unbounded quantity (RFC-1006)", () => {
  test("detects 'fast' trigger", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL respond fast (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.unboundedQuantityViolations).toHaveLength(1);
    expect(result.unboundedQuantityViolations[0]!.trigger).toBe("fast");
  });

  test("detects 'scalable' trigger", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL be scalable (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.unboundedQuantityViolations).toHaveLength(1);
    expect(result.unboundedQuantityViolations[0]!.trigger).toBe("scalable");
  });

  test("does not fire for specific numbers", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL respond within 5 minutes (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.unboundedQuantityViolations).toHaveLength(0);
  });

  test("fires as error for accepted post-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL respond fast (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v40 = filterRule(violations, "V-40");
    expect(v40).toHaveLength(1);
    expect(v40[0]!.severity).toBe("error");
    expect(v40[0]!.message).toContain("fast");
  });

  test("does not fire for pre-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL respond fast (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body, { createdAt: "2026-08-01" });
    const violations = await runValidate(parsed);
    const v40 = filterRule(violations, "V-40");
    expect(v40).toHaveLength(0);
  });
});

// ─── V-41: weasel verb ──────────────────────────────────────────────────────

describe("V-41: weasel verb (RFC-1006)", () => {
  test("detects 'handle gracefully'", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL handle gracefully invalid input (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.weaselVerbViolations).toHaveLength(1);
    expect(result.weaselVerbViolations[0]!.trigger).toBe("handle gracefully");
  });

  test("detects 'robust'", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL be robust (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.weaselVerbViolations).toHaveLength(1);
    expect(result.weaselVerbViolations[0]!.trigger).toBe("robust");
  });

  test("does not fire for specific behavior", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL return exit code 1 for invalid input (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.weaselVerbViolations).toHaveLength(0);
  });

  test("fires as error for accepted post-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL be robust (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v41 = filterRule(violations, "V-41");
    expect(v41).toHaveLength(1);
    expect(v41[0]!.severity).toBe("error");
    expect(v41[0]!.message).toContain("robust");
  });

  test("does not fire for pre-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL be robust (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body, { createdAt: "2026-08-01" });
    const violations = await runValidate(parsed);
    const v41 = filterRule(violations, "V-41");
    expect(v41).toHaveLength(0);
  });
});

// ─── V-42: criterion versioning ─────────────────────────────────────────────

describe("V-42: criterion versioning (RFC-1006)", () => {
  test("superseded criteria are excluded from unchecked count", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "> Superseded AC-1 (2026-09-15): too broad\n- [ ] AC-1: old criterion\n- [x] AC-1a: new criterion (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.supersededIds).toEqual(["AC-1"]);
    expect(result.totalUnchecked).toBe(0);
  });

  test("superseded criteria without annotation still count as unchecked", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "- [ ] AC-1: old criterion\n- [x] AC-1a: new criterion (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.supersededIds).toEqual([]);
    expect(result.totalUnchecked).toBe(1);
  });

  test("malformed supersession annotation is detected", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "> Superseded AC-1 (not-a-date): too broad\n- [ ] AC-1: old criterion\n- [x] AC-1a: new (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.malformedSupersessionAnnotations).toHaveLength(1);
  });

  test("well-formed supersession annotation is not flagged", () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "> Superseded AC-1 (2026-09-15): too broad\n- [ ] AC-1: old criterion\n- [x] AC-1a: new (evidence: test.ts:1)",
    );
    const result = evaluateAcceptanceCriteria(body);
    expect(result.malformedSupersessionAnnotations).toHaveLength(0);
  });

  test("V-42 fires for malformed annotation on post-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "> Superseded AC-1 (not-a-date): too broad\n- [ ] AC-1: old criterion\n- [x] AC-1a: new (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body);
    const violations = await runValidate(parsed);
    const v42 = filterRule(violations, "V-42");
    expect(v42).toHaveLength(1);
    expect(v42[0]!.severity).toBe("error");
  });

  test("V-42 does not fire for pre-cutoff RFCs", async () => {
    const body = BASE_BODY.replace("DOCUMENT_READINESS_HERE", "").replace(
      "ACCEPTANCE_HERE",
      "> Superseded AC-1 (not-a-date): too broad\n- [ ] AC-1: old criterion\n- [x] AC-1a: new (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body, { createdAt: "2026-08-01" });
    const violations = await runValidate(parsed);
    const v42 = filterRule(violations, "V-42");
    expect(v42).toHaveLength(0);
  });
});

// ─── Pre-cutoff exemption: no V-38..V-42 ────────────────────────────────────

describe("Pre-cutoff exemption (RFC-1006)", () => {
  test("pre-cutoff RFCs produce no V-38..V-42 diagnostics", async () => {
    const body = BASE_BODY.replace(
      "DOCUMENT_READINESS_HERE",
      "## Document readiness\n\n- [ ] DR-1: unchecked",
    ).replace(
      "ACCEPTANCE_HERE",
      "- [x] AC-1: THE system SHALL handle gracefully fast input and persist results (evidence: test.ts:1)\n- [x] AC-2: test2 (evidence: test.ts:2)\n- [x] AC-3: test3 (evidence: test.ts:3)",
    );
    const parsed = makeParsed("accepted", body, { createdAt: "2026-08-01" });
    const violations = await runValidate(parsed);
    const newRules = violations.filter(
      (v) => ["V-38", "V-39", "V-40", "V-41", "V-42"].includes(v.rule),
    );
    expect(newRules).toHaveLength(0);
  });
});
