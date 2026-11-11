/*
<MODULE_CONTRACT>
<purpose>RFC-1569 V-53 — evidence-annotation shape lint on every criterion
  line, plus parseEvidenceAnnotation exhaustiveness over the stamp's grammar.</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1569: V-53 rule tests + shared-parser exhaustiveness (AC-1, AC-2, AC-3)</item>
  <item>RFC-1569: lint rfc evidence annotations and transient probe targets</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { validateSingleRfc, type AddViolationFn } from "./validate-rules.ts";
import { parseEvidenceAnnotation } from "../evidence-annotation.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testWorkspace = join(tmpdir(), "test-workspace-rfc1569-v53");

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

async function runValidate(
  parsed: ParsedRfc,
): Promise<{ rfcId: string; rule: string; message: string; severity: string }[]> {
  const violations: { rfcId: string; rule: string; message: string; severity: string }[] = [];
  const add: AddViolationFn = (rfcId, _file, rule, message, severity = "error") => {
    violations.push({ rfcId, rule, message, severity });
  };
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

const PROSE_ANNOTATION =
  "- [ ] AC-1: renders the hero (evidence: probe:AC-2 renders the hero)\n- [ ] AC-2: exits zero\n";

describe("V-53: evidence annotation shape (RFC-1569)", () => {
  test("AC-1: unchecked criterion with prose annotation reports warning on a draft", async () => {
    const violations = await runValidate(
      makeParsed("draft", BASE_BODY.replace("ACCEPTANCE_HERE", PROSE_ANNOTATION)),
    );
    const v53 = violations.filter((v) => v.rule === "V-53");
    expect(v53.length).toBeGreaterThan(0);
    expect(v53.every((v) => v.severity === "warning")).toBe(true);
    expect(v53[0]!.message).toContain("STAMP-CHECK-01");
  });

  test("AC-2: the same annotation on an accepted RFC reports error", async () => {
    const violations = await runValidate(
      makeParsed("accepted", BASE_BODY.replace("ACCEPTANCE_HERE", PROSE_ANNOTATION)),
    );
    const v53 = violations.filter((v) => v.rule === "V-53");
    expect(v53.length).toBeGreaterThan(0);
    expect(v53.every((v) => v.severity === "error")).toBe(true);
  });

  test("resolvable forms produce no V-53", async () => {
    const acceptance = [
      "- [ ] AC-1: c (evidence: test:packages/forge/x.test.ts)",
      "- [ ] AC-2: c (evidence: file:packages/forge/x.ts)",
      "- [ ] AC-3: c (evidence: file:packages/forge/x.ts:12-15)",
      "- [ ] AC-4: c (evidence: packages/forge/x.ts:42)",
      "- [ ] AC-5: c (evidence: probe:design:shared-grammar)",
    ].join("\n");
    const violations = await runValidate(
      makeParsed("draft", BASE_BODY.replace("ACCEPTANCE_HERE", acceptance), {
        acceptance: [
          {
            probe: "file-contains",
            criterion: "design:shared-grammar",
            path: "x",
            pattern: "y",
          },
        ],
      }),
    );
    expect(violations.filter((v) => v.rule === "V-53")).toEqual([]);
  });

  test("probe annotation naming a missing criterion reports V-53", async () => {
    const acceptance = "- [ ] AC-1: c (evidence: probe:AC-9)\n- [ ] AC-2: c (evidence: file:x.ts)";
    const violations = await runValidate(
      makeParsed("draft", BASE_BODY.replace("ACCEPTANCE_HERE", acceptance)),
    );
    const v53 = violations.filter((v) => v.rule === "V-53");
    expect(v53.some((v) => v.message.includes("probe:AC-9"))).toBe(true);
  });
});

describe("AC-3: parseEvidenceAnnotation exhaustiveness (RFC-1569)", () => {
  const resolvable: [string, string][] = [
    ["probe:AC-1", "probe"],
    ["probe:AC-12", "probe"],
    ["probe: design:shared-grammar", "probe"],
    ["test:packages/forge/x.test.ts", "test"],
    ["test: packages/forge/x.test.ts", "test"],
    ["file:packages/forge/x.ts", "file"],
    ["file:packages/forge/x.ts:12", "file"],
    ["file:packages/forge/x.ts:12-15", "file"],
    ["packages/forge/x.ts:42", "path-line"],
    ["packages/forge/x.ts:42-50", "path-line"],
  ];
  for (const [raw, kind] of resolvable) {
    test(`accepts "${raw}" as ${kind}`, () => {
      const parsed = parseEvidenceAnnotation(raw);
      expect(parsed.kind).toBe(kind);
    });
  }
  const unresolvable = [
    "probe:AC-2 renders the hero",
    "probe:AC-1 or test: <path>",
    "test:",
    "file: <module-path> with prose",
    "",
    "anything else",
  ];
  for (const raw of unresolvable) {
    test(`rejects "${raw}"`, () => {
      expect(parseEvidenceAnnotation(raw).kind).toBe("invalid");
    });
  }
});
