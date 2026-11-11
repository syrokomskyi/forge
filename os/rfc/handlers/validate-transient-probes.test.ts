/*
<MODULE_CONTRACT>
<purpose>RFC-1569 V-54 — transient probe target lint: missions/ paths,
  --mission flags, app-scoped run commands, outcomeBuild exemption.</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1569: V-54 rule tests (AC-4, AC-5, --mission/app-scope arms)</item>
  <item>RFC-1569: lint rfc evidence annotations and transient probe targets</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { validateSingleRfc, type AddViolationFn } from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testWorkspace = join(tmpdir(), "test-workspace-rfc1569-v54");

beforeAll(() => {
  mkdirSync(join(testWorkspace, "docs"), { recursive: true });
  writeFileSync(
    join(testWorkspace, "forge.yaml"),
    'bindings:\n  commands:\n    outcomeBuild: "werkstatt run leitstand.build --id {target}"\n',
  );
  writeFileSync(
    join(testWorkspace, "docs", "command-manifest.generated.yaml"),
    "commands:\n  - name: agent.api-catalog.validate\n    scope: app\n  - name: rfc.validate\n    scope: workspace\n",
  );
});

function makeParsed(body: string, acceptance: unknown[]): ParsedRfc {
  return {
    frontmatter: {
      id: "RFC-9999",
      title: "Test RFC",
      status: "draft",
      kind: "command",
      scope: "workspace",
      owners: ["architecture"],
      createdAt: "2026-09-01",
      updatedAt: "2026-09-01",
      acceptance,
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

- [ ] AC-1: first criterion
- [ ] AC-2: second criterion

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
  return violations.filter((v) => v.rule === "V-54");
}

describe("V-54: transient probe targets (RFC-1569)", () => {
  test("AC-4: file-contains probe under missions/ reports warning", async () => {
    const violations = await runValidate(
      makeParsed(BASE_BODY, [
        {
          probe: "file-contains",
          criterion: "AC-1",
          path: "missions/warpgogol-m000219/workpiece/src/index.astro",
          pattern: "hero",
        },
      ]),
    );
    expect(violations.length).toBe(1);
    expect(violations[0]!.severity).toBe("warning");
    expect(violations[0]!.message).toContain("missions/");
  });

  test("missions/archive/ path is durable — no V-54", async () => {
    const violations = await runValidate(
      makeParsed(BASE_BODY, [
        {
          probe: "file-exists",
          criterion: "AC-1",
          path: "missions/archive/warpgogol-m000219/report.json",
        },
      ]),
    );
    expect(violations).toEqual([]);
  });

  test("run probe carrying --mission reports warning", async () => {
    const violations = await runValidate(
      makeParsed(BASE_BODY, [
        {
          probe: "run",
          criterion: "AC-1",
          command: "werkstatt run mission.validate --mission m000219 --json",
        },
      ]),
    );
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("--mission");
  });

  test("app-scoped run command reports warning", async () => {
    const violations = await runValidate(
      makeParsed(BASE_BODY, [
        {
          probe: "run",
          criterion: "AC-1",
          command: "pnpm exec werkstatt run agent.api-catalog.validate --app warpgogol",
        },
      ]),
    );
    expect(violations.length).toBe(1);
    expect(violations[0]!.message).toContain("agent.api-catalog.validate");
  });

  test("AC-5: outcomeBuild binding command is exempt", async () => {
    const violations = await runValidate(
      makeParsed(BASE_BODY, [
        {
          probe: "run",
          criterion: "AC-1",
          command: "werkstatt run leitstand.build --id warpgogol",
        },
      ]),
    );
    expect(violations).toEqual([]);
  });

  test("workspace-scoped run command is clean", async () => {
    const violations = await runValidate(
      makeParsed(BASE_BODY, [
        {
          probe: "run",
          criterion: "AC-1",
          command: "pnpm exec werkstatt run rfc.validate --id RFC-9999",
        },
      ]),
    );
    expect(violations).toEqual([]);
  });
});
