/*
<MODULE_CONTRACT>
<purpose>
RFC-1336: V-25 delegation coverage — an agent:&lt;id&gt; reviewer on a decided
RFC is valid iff frontmatter decidedBy names the granting human AND an active
rfc.decision delegation covers the agent under that grantor
(authority.delegations.yaml). Human reviewers and the no-delegation path are
unchanged.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1336: initial test — V-25 delegated reviewer verdicts over tmp registries.</item>
  <item>RFC-1336: delegated rfc.decision/version.major/onboarding.decision + docs (RFC-1336 steps 4-5)</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateSingleRfc, type AddViolationFn } from "../../os/rfc/handlers/validate-rules.ts";
import type { ParsedRfc } from "../../os/rfc/frontmatter-io.ts";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "v25-deleg-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const BODY = `
# RFC-9999: Test RFC

## Context

x

## Problem

x

## Decision

x

## Architectural fit

x

## Design

x

## Rollout

x

## Alternatives considered

x

## Risks

x

## Acceptance criteria

x

## Implementation notes for agents

x
`;

function makeParsed(extraFm: Record<string, unknown> = {}): ParsedRfc {
  return {
    frontmatter: {
      id: "RFC-9999",
      title: "Test RFC",
      status: "accepted",
      kind: "command",
      scope: "workspace",
      owners: ["architecture"],
      createdAt: "2026-10-19",
      updatedAt: "2026-10-19",
      ...extraFm,
    },
    body: BODY,
  };
}

function writeRegistry(yaml: string): void {
  writeFileSync(join(workspace, "authority.delegations.yaml"), yaml);
}

const GRANTOR = "human:andrii-syrokomskyi";

function delegationRegistry(grantedTo: string, grantedBy = GRANTOR): string {
  return `schema: forge/authority-delegations@1
delegations:
  - id: del-0050
    scope: rfc.decision
    grantedTo: ${grantedTo}
    grantedBy: ${grantedBy}
    grantedAt: "2026-10-19T10:00:00.000Z"
    sites: workspace
`;
}

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
    workspace,
    add,
  );
  return violations.filter((v) => v.rule === "V-25");
}

describe("V-25 delegated reviewers (RFC-1336)", () => {
  test("human reviewer — unchanged, no V-25", async () => {
    const v = await runValidate(makeParsed({ reviewers: ["human:andrii"] }));
    expect(v).toHaveLength(0);
  });

  test("agent reviewer without decidedBy — V-25 (legacy rule intact)", async () => {
    const v = await runValidate(makeParsed({ reviewers: ["agent:devin"] }));
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("decidedBy");
  });

  test("agent reviewer + decidedBy, no registry — V-25", async () => {
    const v = await runValidate(makeParsed({ reviewers: ["agent:devin"], decidedBy: GRANTOR }));
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("rfc.decision delegation");
  });

  test("agent reviewer + decidedBy + active delegation — no V-25", async () => {
    writeRegistry(delegationRegistry("agent:devin"));
    const v = await runValidate(makeParsed({ reviewers: ["agent:devin"], decidedBy: GRANTOR }));
    expect(v).toHaveLength(0);
  });

  test("delegation granted by a different human than decidedBy — V-25 (grantor binding)", async () => {
    writeRegistry(delegationRegistry("agent:devin", "human:someone-else"));
    const v = await runValidate(makeParsed({ reviewers: ["agent:devin"], decidedBy: GRANTOR }));
    expect(v).toHaveLength(1);
  });

  test("delegation to a different agent does not cover this reviewer", async () => {
    writeRegistry(delegationRegistry("agent:cursor"));
    const v = await runValidate(makeParsed({ reviewers: ["agent:devin"], decidedBy: GRANTOR }));
    expect(v).toHaveLength(1);
  });

  test("wildcard delegation covers a named agent", async () => {
    writeRegistry(delegationRegistry("agent:*"));
    const v = await runValidate(makeParsed({ reviewers: ["agent:devin"], decidedBy: GRANTOR }));
    expect(v).toHaveLength(0);
  });
});
