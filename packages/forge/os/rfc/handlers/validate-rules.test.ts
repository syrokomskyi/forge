import { test, expect, describe } from "vitest";
import { validateSingleRfc, type AddViolationFn } from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

describe("V-32: implementation commit drift detection", () => {
  function createGitRepoWithCommits(commits: { message: string; date: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "v32-test-"));
    execSync("git init", { cwd: dir, timeout: 5000 });
    execSync("git config user.email test@test.com", { cwd: dir, timeout: 5000 });
    execSync("git config user.name Test", { cwd: dir, timeout: 5000 });
    for (const c of commits) {
      execSync(
        `GIT_AUTHOR_DATE="${c.date}" GIT_COMMITTER_DATE="${c.date}" git commit --allow-empty -m "${c.message}"`,
        { cwd: dir, timeout: 5000 },
      );
    }
    return dir;
  }

  async function runValidateInDir(
    parsed: ParsedRfc,
    workspaceRoot: string,
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
      workspaceRoot,
      add,
    );
    return violations;
  }

  test("V-32 warning when accepted RFC has implement: commits", async () => {
    const dir = createGitRepoWithCommits([
      { message: "implement: RFC-9999 — step 1", date: "2026-01-02T10:00:00" },
    ]);
    try {
      const parsed = makeParsed("accepted", BASE_BODY);
      const violations = await runValidateInDir(parsed, dir);
      const v32 = filterRule(violations, "V-32");
      expect(v32).toHaveLength(1);
      expect(v32[0]!.severity).toBe("warning");
      expect(v32[0]!.message).toContain("RFC-9999");
      expect(v32[0]!.message).toContain("accepted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no V-32 when status is implemented", async () => {
    const dir = createGitRepoWithCommits([
      { message: "implement: RFC-9999 — step 1", date: "2026-01-02T10:00:00" },
    ]);
    try {
      const body = BASE_BODY.replace(
        "ACCEPTANCE_HERE",
        "- [x] done (evidence: test.ts:1)\n- [x] another (evidence: test.ts:2)\n- [x] third (evidence: test.ts:3)",
      );
      const parsed = makeParsed("implemented", body, {
        implementedAt: "2026-01-03",
      });
      const violations = await runValidateInDir(parsed, dir);
      const v32 = filterRule(violations, "V-32");
      expect(v32).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no V-32 when no implement: commits exist", async () => {
    const dir = createGitRepoWithCommits([
      { message: "feat: add some feature", date: "2026-01-02T10:00:00" },
    ]);
    try {
      const parsed = makeParsed("accepted", BASE_BODY);
      const violations = await runValidateInDir(parsed, dir);
      const v32 = filterRule(violations, "V-32");
      expect(v32).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no V-32 in non-git directory", async () => {
    const parsed = makeParsed("accepted", BASE_BODY);
    const violations = await runValidateInDir(parsed, "/tmp/nonexistent-xyz");
    const v32 = filterRule(violations, "V-32");
    expect(v32).toHaveLength(0);
  });
});

describe("V-16: status <-> implementedAt coupling (error, not warning)", () => {
  test("error when status is accepted but implementedAt is set", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, {
      implementedAt: "2026-01-15",
    });
    const violations = await runValidate(parsed);
    const v16 = filterRule(violations, "V-16");
    expect(v16).toHaveLength(1);
    expect(v16[0]!.severity).toBe("error");
    expect(v16[0]!.message).toContain("accepted");
    expect(v16[0]!.message).toContain("implementedAt");
  });

  test("error when status is draft but implementedAt is set", async () => {
    const parsed = makeParsed("draft", BASE_BODY, {
      implementedAt: "2026-01-15",
    });
    const violations = await runValidate(parsed);
    const v16 = filterRule(violations, "V-16");
    expect(v16).toHaveLength(1);
    expect(v16[0]!.severity).toBe("error");
    expect(v16[0]!.message).toContain("draft");
  });

  test("error when status is implemented but implementedAt is empty", async () => {
    const parsed = makeParsed("implemented", BASE_BODY);
    const violations = await runValidate(parsed);
    const v16 = filterRule(violations, "V-16");
    expect(v16).toHaveLength(1);
    expect(v16[0]!.severity).toBe("error");
    expect(v16[0]!.message).toContain("implemented");
    expect(v16[0]!.message).toContain("empty");
  });

  test("no V-16 when status is implemented and implementedAt is set", async () => {
    const parsed = makeParsed("implemented", BASE_BODY, {
      implementedAt: "2026-01-15",
    });
    const violations = await runValidate(parsed);
    const v16 = filterRule(violations, "V-16");
    expect(v16).toHaveLength(0);
  });

  test("no V-16 when status is accepted and implementedAt is empty", async () => {
    const parsed = makeParsed("accepted", BASE_BODY);
    const violations = await runValidate(parsed);
    const v16 = filterRule(violations, "V-16");
    // V-16 for implementedAt should not fire; closedAt warnings may exist but are separate
    const implV16 = v16.filter((v) => v.message.includes("implementedAt"));
    expect(implV16).toHaveLength(0);
  });
});
