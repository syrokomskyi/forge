/*
<MODULE_CONTRACT>
<purpose>Unit tests for validate rules rfc1330 covering V-44: WHEN/IF behavioral criteria bound only to presence probes are rejected for post-cutoff RFCs.</purpose>
<non-goals>
  <item>Not a contract source of truth — validate-rules.ts owns V-44; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1330: V-44 tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findPresenceOnlyBehavioralCriteria,
  type AddViolationFn,
  validateSingleRfc,
} from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import type { AcceptanceProbe } from "../types.ts";

const BODY = (criteria: string): string => `
# RFC-9998: Test RFC

## Acceptance criteria

${criteria}

## Implementation notes for agents

Notes.
`;

async function v44(createdAt: string, criteria: string, probes: AcceptanceProbe[]) {
  const parsed: ParsedRfc = {
    frontmatter: {
      id: "RFC-9998",
      title: "Test RFC",
      status: "draft",
      kind: "command",
      scope: "workspace",
      owners: ["architecture"],
      createdAt,
      updatedAt: createdAt,
      acceptance: probes,
    },
    body: BODY(criteria),
  };
  const found: string[] = [];
  const add: AddViolationFn = (_id, _file, rule, message) => {
    if (rule === "V-44") found.push(message);
  };
  await validateSingleRfc(
    "rfc-9998-test.md",
    parsed,
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    new Set(Object.keys(parsed.frontmatter)),
    join(tmpdir(), "test-workspace-rfc1330"),
    add,
  );
  return found;
}

const presence: AcceptanceProbe = {
  probe: "file-contains",
  criterion: "AC-1",
  path: "packages/x/src/gate.ts",
  pattern: "EC-99",
};

describe("V-44 (RFC-1330)", () => {
  test("V-44 rejects an event criterion bound only to presence probes", async () => {
    const found = await v44(
      "2026-10-18",
      "- [ ] AC-1: WHEN a commit weakens a test, THE gate SHALL block it.",
      [presence],
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("AC-1");
  });

  test("accepts an event criterion that also has an execution probe", async () => {
    const found = await v44(
      "2026-10-18",
      "- [ ] AC-1: IF the input is empty, THEN the command SHALL fail.",
      [presence, { probe: "test", criterion: "AC-1", file: "a.test.ts", expect: { exitCode: 0 } }],
    );
    expect(found).toEqual([]);
  });

  test("leaves invariant-form and doc-targeted criteria alone", () => {
    const body = BODY(
      "- [ ] AC-1: THE module SHALL export X.\n- [ ] AC-2: WHEN archived, THE index SHALL list it.",
    );
    const offenders = findPresenceOnlyBehavioralCriteria(body, [
      presence,
      { probe: "file-contains", criterion: "AC-2", path: "docs/index.md", pattern: "x" },
    ]);
    expect(offenders).toEqual([]);
  });

  test("treats uppercase checked boxes as criteria", () => {
    const body = BODY("- [X] AC-1: WHEN a commit weakens a test, THE gate SHALL block it.");
    expect(findPresenceOnlyBehavioralCriteria(body, [presence])).toEqual(["AC-1"]);
  });

  test("exempts RFCs created before the cutoff", async () => {
    const found = await v44(
      "2026-10-17",
      "- [ ] AC-1: WHEN a commit weakens a test, THE gate SHALL block it.",
      [presence],
    );
    expect(found).toEqual([]);
  });
});
