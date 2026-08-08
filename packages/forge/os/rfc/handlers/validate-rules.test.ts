import { test, expect, describe } from "vitest";
import {
  validateSingleRfc,
  collectMarkers,
  checkFrontmatterYamlParse,
  type AddViolationFn,
} from "./validate-rules.ts";
import type { ParsedRfc } from "../frontmatter-io.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testWorkspace = join(tmpdir(), "test-workspace");

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
      testWorkspace,
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
      testWorkspace,
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
      testWorkspace,
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
      testWorkspace,
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
      execFileSync("git", ["commit", "--allow-empty", "-m", c.message], {
        cwd: dir,
        timeout: 5000,
        env: { ...process.env, GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date },
        stdio: "pipe",
      });
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
    const violations = await runValidateInDir(parsed, join(tmpdir(), "nonexistent-xyz"));
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

describe("V-NC-01: NEEDS CLARIFICATION marker detection (RFC-0709)", () => {
  test("draft RFC with marker produces warning violation", async () => {
    const body = BASE_BODY.replace(
      "Test context.",
      "> NEEDS CLARIFICATION: what is the exact scope?\n\nTest context.",
    );
    const parsed = makeParsed("draft", body, { createdAt: "2026-08-06" });
    const violations = await runValidate(parsed);
    const nc = filterRule(violations, "V-NC-01");
    expect(nc).toHaveLength(1);
    expect(nc[0]!.severity).toBe("warning");
    expect(nc[0]!.message).toContain("NEEDS CLARIFICATION");
  });

  test("accepted RFC with marker produces error violation", async () => {
    const body = BASE_BODY.replace(
      "Test context.",
      "> NEEDS CLARIFICATION: what is the exact scope?\n\nTest context.",
    );
    const parsed = makeParsed("accepted", body, { createdAt: "2026-08-06" });
    const violations = await runValidate(parsed);
    const nc = filterRule(violations, "V-NC-01");
    expect(nc).toHaveLength(1);
    expect(nc[0]!.severity).toBe("error");
  });

  test("RFC with marker inside code block produces no V-NC-01 violation", async () => {
    const body = BASE_BODY.replace(
      "Test context.",
      "```\n> NEEDS CLARIFICATION: inside code block\n```\n\nTest context.",
    );
    const parsed = makeParsed("draft", body, { createdAt: "2026-08-06" });
    const violations = await runValidate(parsed);
    const nc = filterRule(violations, "V-NC-01");
    expect(nc).toHaveLength(0);
  });

  test("RFC with createdAt before cutoff is exempt", async () => {
    const body = BASE_BODY.replace(
      "Test context.",
      "> NEEDS CLARIFICATION: old marker\n\nTest context.",
    );
    const parsed = makeParsed("draft", body, { createdAt: "2026-08-05" });
    const violations = await runValidate(parsed);
    const nc = filterRule(violations, "V-NC-01");
    expect(nc).toHaveLength(0);
  });

  test("RFC with no markers produces no V-NC-01 violations", async () => {
    const parsed = makeParsed("draft", BASE_BODY, { createdAt: "2026-08-06" });
    const violations = await runValidate(parsed);
    const nc = filterRule(violations, "V-NC-01");
    expect(nc).toHaveLength(0);
  });

  test("multiple markers produce multiple violations with correct line numbers", async () => {
    const body = BASE_BODY.replace(
      "Test context.",
      "> NEEDS CLARIFICATION: first question\n\nSome text.\n\n> NEEDS CLARIFICATION: second question\n\nTest context.",
    );
    const parsed = makeParsed("draft", body, { createdAt: "2026-08-06" });
    const violations = await runValidate(parsed);
    const nc = filterRule(violations, "V-NC-01");
    expect(nc).toHaveLength(2);
    expect(nc[0]!.message).toContain("first question");
    expect(nc[1]!.message).toContain("second question");
  });

  test("lowercase 'needs clarification' is not matched (case-sensitive)", async () => {
    const body = BASE_BODY.replace(
      "Test context.",
      "> needs clarification: lowercase marker\n\nTest context.",
    );
    const parsed = makeParsed("draft", body, { createdAt: "2026-08-06" });
    const violations = await runValidate(parsed);
    const nc = filterRule(violations, "V-NC-01");
    expect(nc).toHaveLength(0);
  });

  test("collectMarkers pure function returns correct markers", () => {
    const body = "Line 1\n> NEEDS CLARIFICATION: test marker\nLine 3";
    const markers = collectMarkers(body, "draft", "2026-08-06");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.line).toBe(2);
    expect(markers[0]!.text).toBe("test marker");
    expect(markers[0]!.severity).toBe("warn");
  });

  test("collectMarkers returns error severity for accepted status", () => {
    const body = "> NEEDS CLARIFICATION: test marker";
    const markers = collectMarkers(body, "accepted", "2026-08-06");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.severity).toBe("error");
  });

  test("collectMarkers returns empty for pre-cutoff createdAt", () => {
    const body = "> NEEDS CLARIFICATION: test marker";
    const markers = collectMarkers(body, "draft", "2026-08-05");
    expect(markers).toHaveLength(0);
  });
});

describe("V-29: versionBump required for post-cutoff accepted/implemented RFCs (RFC-0478, ADR-0029)", () => {
  test("error when post-cutoff accepted RFC lacks versionBump", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, { createdAt: "2026-07-21" });
    const violations = await runValidate(parsed);
    const v29 = filterRule(violations, "V-29");
    expect(v29).toHaveLength(1);
    expect(v29[0]!.severity).toBe("error");
    expect(v29[0]!.message).toContain("accepted");
    expect(v29[0]!.message).toContain("versionBump");
  });

  test("error when post-cutoff implemented RFC lacks versionBump", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] done (evidence: test.ts:1)\n- [x] another (evidence: test.ts:2)",
    );
    const parsed = makeParsed("implemented", body, {
      createdAt: "2026-07-21",
      implementedAt: "2026-07-22",
    });
    const violations = await runValidate(parsed);
    const v29 = filterRule(violations, "V-29");
    expect(v29).toHaveLength(1);
    expect(v29[0]!.severity).toBe("error");
    expect(v29[0]!.message).toContain("implemented");
  });

  test("no error when post-cutoff accepted RFC has versionBump", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, {
      createdAt: "2026-07-21",
      versionBump: "patch",
    });
    const violations = await runValidate(parsed);
    const v29 = filterRule(violations, "V-29");
    expect(v29).toHaveLength(0);
  });

  test("no error when post-cutoff implemented RFC has versionBump", async () => {
    const body = BASE_BODY.replace(
      "ACCEPTANCE_HERE",
      "- [x] done (evidence: test.ts:1)\n- [x] another (evidence: test.ts:2)",
    );
    const parsed = makeParsed("implemented", body, {
      createdAt: "2026-07-21",
      implementedAt: "2026-07-22",
      versionBump: "minor",
    });
    const violations = await runValidate(parsed);
    const v29 = filterRule(violations, "V-29");
    expect(v29).toHaveLength(0);
  });

  test("no error when pre-cutoff accepted RFC lacks versionBump", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, { createdAt: "2026-07-20" });
    const violations = await runValidate(parsed);
    const v29 = filterRule(violations, "V-29");
    expect(v29).toHaveLength(0);
  });

  test("no error when draft RFC lacks versionBump (regardless of cutoff)", async () => {
    const parsed = makeParsed("draft", BASE_BODY, { createdAt: "2026-07-21" });
    const violations = await runValidate(parsed);
    const v29 = filterRule(violations, "V-29");
    expect(v29).toHaveLength(0);
  });

  test("warning when versionBump is none but commands.added is non-empty", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, {
      createdAt: "2026-07-21",
      versionBump: "none",
      commands: { added: ["some.command"], changed: [], removed: [] },
    });
    const violations = await runValidate(parsed);
    const v29 = filterRule(violations, "V-29");
    expect(v29).toHaveLength(1);
    expect(v29[0]!.severity).toBe("warning");
    expect(v29[0]!.message).toContain("none");
  });

  test("no warning when versionBump is none and no commands added/changed", async () => {
    const parsed = makeParsed("accepted", BASE_BODY, {
      createdAt: "2026-07-21",
      versionBump: "none",
      commands: { added: [], changed: [], removed: [] },
    });
    const violations = await runValidate(parsed);
    const v29 = filterRule(violations, "V-29");
    expect(v29).toHaveLength(0);
  });
});

describe("RFC-DIR-01: directory structure convention (RFC-0722)", () => {
  test("warning when RFC file is in an unsanctioned subdirectory", async () => {
    const parsed = makeParsed("accepted", BASE_BODY);
    const { add, violations } = makeViolationsCollector();
    await validateSingleRfc(
      "draft/rfc-9999-test.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      testWorkspace,
      add,
    );
    const dir01 = filterRule(violations, "RFC-DIR-01");
    expect(dir01).toHaveLength(1);
    expect(dir01[0]!.severity).toBe("warning");
    expect(dir01[0]!.message).toContain("unsanctioned subdirectory");
  });

  test("no warning when RFC file is at root", async () => {
    const parsed = makeParsed("accepted", BASE_BODY);
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
    const dir01 = filterRule(violations, "RFC-DIR-01");
    expect(dir01).toHaveLength(0);
  });

  test("no warning when RFC file is in archive/ subdirectory", async () => {
    const parsed = makeParsed("implemented", BASE_BODY);
    const { add, violations } = makeViolationsCollector();
    await validateSingleRfc(
      "archive/implemented/rfc-9999-test.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      testWorkspace,
      add,
    );
    const dir01 = filterRule(violations, "RFC-DIR-01");
    expect(dir01).toHaveLength(0);
  });

  test("no warning when RFC file is in verification/ subdirectory", async () => {
    const parsed = makeParsed("accepted", BASE_BODY);
    const { add, violations } = makeViolationsCollector();
    await validateSingleRfc(
      "verification/rfc-9999-test.md",
      parsed,
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      new Set(Object.keys(parsed.frontmatter)),
      testWorkspace,
      add,
    );
    const dir01 = filterRule(violations, "RFC-DIR-01");
    expect(dir01).toHaveLength(0);
  });
});

describe("V-RFC-33: frontmatter YAML parseability (RFC-0755)", () => {
  test("produces violation when result has error variant", () => {
    const { add, violations } = makeViolationsCollector();
    const errorResult = {
      fileName: "rfc-0100-bad.md",
      error: "YAML parse error at line 3, column 5: bad indentation",
    };
    checkFrontmatterYamlParse("rfc-0100-bad.md", errorResult, add);
    const v33 = filterRule(violations, "V-RFC-33");
    expect(v33).toHaveLength(1);
    expect(v33[0]!.message).toContain("rfc-0100-bad.md");
    expect(v33[0]!.message).toContain("YAML parse error");
    expect(v33[0]!.message).toContain("bad indentation");
  });

  test("produces no violation when result has parsed variant", () => {
    const { add, violations } = makeViolationsCollector();
    const parsedResult = {
      fileName: "rfc-0100-ok.md",
      parsed: { frontmatter: { id: "RFC-0100" }, body: "# RFC-0100\n" },
    };
    checkFrontmatterYamlParse("rfc-0100-ok.md", parsedResult, add);
    const v33 = filterRule(violations, "V-RFC-33");
    expect(v33).toHaveLength(0);
  });

  test("produces no violation when result is undefined", () => {
    const { add, violations } = makeViolationsCollector();
    checkFrontmatterYamlParse("rfc-0100-missing.md", undefined, add);
    const v33 = filterRule(violations, "V-RFC-33");
    expect(v33).toHaveLength(0);
  });
});
