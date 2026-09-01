import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAdrValidate } from "./validate.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

const ADR_BODY = `
# ADR-9999: Test ADR

## Context

Test context.

## Decision

Test decision.

## Consequences

Test consequences.
`;

function createAdrFile(
  workspaceRoot: string,
  id: string,
  status: string,
  body: string,
  extraFm: Record<string, unknown> = {},
): void {
  const adrDir = join(workspaceRoot, "docs", "adrs");
  mkdirSync(adrDir, { recursive: true });
  const slug = id.toLowerCase();
  const fm = [
    "---",
    `id: ${id}`,
    `title: "Test ADR"`,
    `status: ${status}`,
    `scope: package`,
    `decider: human:test`,
    `createdAt: 2026-01-01`,
    `updatedAt: 2026-01-01`,
    ...Object.entries(extraFm).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    body,
  ].join("\n");
  writeFileSync(join(adrDir, `${slug}-test.md`), fm);
}

function createGitRepoWithCommits(commits: { message: string; date: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "av16-test-"));
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

async function runValidate(
  workspaceRoot: string,
  targetId?: string,
): Promise<{ rule: string; message: string; severity: string }[]> {
  const input: ForgeCommandInput = {
    argv: [],
    flags: targetId ? { id: targetId } : {},
  };
  const context: ForgeRuntimeContext = {
    workspaceRoot,
    logger: {
      info: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      section: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
  const result = await runAdrValidate(input, context);
  return (result.data?.violations ?? []).map((v) => ({
    rule: v.rule,
    message: v.message,
    severity: v.severity,
  }));
}

function filterRule(
  violations: { rule: string; message: string; severity: string }[],
  rule: string,
): { rule: string; message: string; severity: string }[] {
  return violations.filter((v) => v.rule === rule);
}

describe("AV-16: implementation commit drift detection", () => {
  test("AV-16 warning when accepted ADR has implement: commits", async () => {
    const dir = createGitRepoWithCommits([
      { message: "implement: ADR-9999 — step 1", date: "2026-01-02T10:00:00" },
    ]);
    try {
      createAdrFile(dir, "ADR-9999", "accepted", ADR_BODY);
      const violations = await runValidate(dir, "ADR-9999");
      const av16 = filterRule(violations, "AV-16");
      expect(av16).toHaveLength(1);
      expect(av16[0]!.severity).toBe("warning");
      expect(av16[0]!.message).toContain("ADR-9999");
      expect(av16[0]!.message).toContain("accepted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no AV-16 when status is implemented", async () => {
    const dir = createGitRepoWithCommits([
      { message: "implement: ADR-9999 — step 1", date: "2026-01-02T10:00:00" },
    ]);
    try {
      createAdrFile(dir, "ADR-9999", "implemented", ADR_BODY, {
        implementedAt: "2026-01-03",
      });
      const violations = await runValidate(dir, "ADR-9999");
      const av16 = filterRule(violations, "AV-16");
      expect(av16).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no AV-16 when no implement: commits exist", async () => {
    const dir = createGitRepoWithCommits([
      { message: "feat: add some feature", date: "2026-01-02T10:00:00" },
    ]);
    try {
      createAdrFile(dir, "ADR-9999", "accepted", ADR_BODY);
      const violations = await runValidate(dir, "ADR-9999");
      const av16 = filterRule(violations, "AV-16");
      expect(av16).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no AV-16 in non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av16-nogit-"));
    try {
      createAdrFile(dir, "ADR-9999", "accepted", ADR_BODY);
      const violations = await runValidate(dir, "ADR-9999");
      const av16 = filterRule(violations, "AV-16");
      expect(av16).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ADR-DIR-01: directory structure convention (RFC-0722)", () => {
  function createAdrInSubdir(
    workspaceRoot: string,
    subdir: string,
    id: string,
    status: string,
    body: string,
    extraFm: Record<string, unknown> = {},
  ): void {
    const adrDir = join(workspaceRoot, "docs", "adrs", subdir);
    mkdirSync(adrDir, { recursive: true });
    const slug = id.toLowerCase();
    const fm = [
      "---",
      `id: ${id}`,
      `title: "Test ADR"`,
      `status: ${status}`,
      `scope: package`,
      `decider: human:test`,
      `createdAt: 2026-01-01`,
      `updatedAt: 2026-01-01`,
      ...Object.entries(extraFm).map(([k, v]) => `${k}: ${v}`),
      "---",
      "",
      body,
    ].join("\n");
    writeFileSync(join(adrDir, `${slug}-test.md`), fm);
  }

  test("warning when ADR file is in an unsanctioned subdirectory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adr-dir01-bad-"));
    try {
      createAdrInSubdir(dir, "draft", "ADR-9999", "accepted", ADR_BODY);
      const violations = await runValidate(dir, "ADR-9999");
      const dir01 = filterRule(violations, "ADR-DIR-01");
      expect(dir01).toHaveLength(1);
      expect(dir01[0]!.severity).toBe("warning");
      expect(dir01[0]!.message).toContain("unsanctioned subdirectory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no warning when ADR file is at root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adr-dir01-root-"));
    try {
      createAdrFile(dir, "ADR-9999", "accepted", ADR_BODY);
      const violations = await runValidate(dir, "ADR-9999");
      const dir01 = filterRule(violations, "ADR-DIR-01");
      expect(dir01).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no warning when ADR file is in archive/ subdirectory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adr-dir01-archive-"));
    try {
      createAdrInSubdir(dir, "archive", "ADR-9999", "implemented", ADR_BODY, {
        implementedAt: "2026-01-02",
      });
      const violations = await runValidate(dir, "ADR-9999");
      const dir01 = filterRule(violations, "ADR-DIR-01");
      expect(dir01).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const ADR_BODY_WITH_CRITERIA = `
# ADR-9998: Test ADR with criteria

## Context

Test context.

## Decision

Test decision.

## Consequences

Test consequences.

## Evolution

Test evolution.

## Acceptance criteria

- [ ] AC-1: THE system SHALL do X
- [ ] AC-2: THE system SHALL do Y
`;

const ADR_BODY_WITH_CHECKED_CRITERIA_NO_EVIDENCE = `
# ADR-9997: Test ADR with checked criteria no evidence

## Context

Test context.

## Decision

Test decision.

## Consequences

Test consequences.

## Evolution

Test evolution.

## Acceptance criteria

- [x] AC-1: THE system SHALL do X
- [x] AC-2: THE system SHALL do Y
`;

const ADR_BODY_WITH_CHECKED_CRITERIA_WITH_EVIDENCE = `
# ADR-9996: Test ADR with checked criteria with evidence

## Context

Test context.

## Decision

Test decision.

## Consequences

Test consequences.

## Evolution

Test evolution.

## Acceptance criteria

- [x] AC-1: THE system SHALL do X (evidence: test: src/test.test.ts)
- [x] AC-2: THE system SHALL do Y (evidence: file: src/index.ts:42)
`;

function createAdrFilePostCutoff(
  workspaceRoot: string,
  id: string,
  status: string,
  body: string,
  extraFm: Record<string, unknown> = {},
): void {
  const adrDir = join(workspaceRoot, "docs", "adrs");
  mkdirSync(adrDir, { recursive: true });
  const slug = id.toLowerCase();
  const fm = [
    "---",
    `id: ${id}`,
    `title: "Test ADR"`,
    `status: ${status}`,
    `scope: package`,
    `decider: human:test`,
    `createdAt: 2026-09-15`,
    `updatedAt: 2026-09-15`,
    ...Object.entries(extraFm).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    body,
  ].join("\n");
  writeFileSync(join(adrDir, `${slug}-test.md`), fm);
}

describe("AV-17: acceptance criteria completeness for implemented post-cutoff ADRs (RFC-0996)", () => {
  test("AC-6: post-cutoff implemented ADR with unchecked criteria → AV-17 error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av17-unchecked-"));
    try {
      createAdrFilePostCutoff(dir, "ADR-9998", "implemented", ADR_BODY_WITH_CRITERIA, {
        implementedAt: "2026-09-16",
      });
      const violations = await runValidate(dir, "ADR-9998");
      const av17 = filterRule(violations, "AV-17");
      expect(av17).toHaveLength(1);
      expect(av17[0]!.severity).toBe("error");
      expect(av17[0]!.message).toContain("2 unchecked acceptance criteria");
      expect(av17[0]!.message).toContain("implemented");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-7: post-cutoff implemented ADR with checked criteria but no evidence → AV-17 error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av17-noevidence-"));
    try {
      createAdrFilePostCutoff(
        dir,
        "ADR-9997",
        "implemented",
        ADR_BODY_WITH_CHECKED_CRITERIA_NO_EVIDENCE,
        {
          implementedAt: "2026-09-16",
        },
      );
      const violations = await runValidate(dir, "ADR-9997");
      const av17 = filterRule(violations, "AV-17");
      expect(av17).toHaveLength(2);
      expect(av17.every((v) => v.severity === "error")).toBe(true);
      expect(av17.every((v) => v.message.includes("without (evidence: ...)"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-8a: pre-cutoff implemented ADR with unchecked criteria → no AV-17", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av17-precutoff-"));
    try {
      createAdrFile(dir, "ADR-9998", "implemented", ADR_BODY_WITH_CRITERIA, {
        implementedAt: "2026-01-15",
      });
      const violations = await runValidate(dir, "ADR-9998");
      const av17 = filterRule(violations, "AV-17");
      expect(av17).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-8b: post-cutoff implemented ADR without criteria section → no AV-17", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av17-nosection-"));
    try {
      createAdrFilePostCutoff(dir, "ADR-9999", "implemented", ADR_BODY, {
        implementedAt: "2026-09-16",
      });
      const violations = await runValidate(dir, "ADR-9999");
      const av17 = filterRule(violations, "AV-17");
      expect(av17).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-8c: post-cutoff accepted (not implemented) ADR with unchecked criteria → no AV-17", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av17-notimplemented-"));
    try {
      createAdrFilePostCutoff(dir, "ADR-9998", "accepted", ADR_BODY_WITH_CRITERIA);
      const violations = await runValidate(dir, "ADR-9998");
      const av17 = filterRule(violations, "AV-17");
      expect(av17).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("post-cutoff implemented ADR with all criteria checked and evidence → no AV-17", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av17-clean-"));
    try {
      createAdrFilePostCutoff(
        dir,
        "ADR-9996",
        "implemented",
        ADR_BODY_WITH_CHECKED_CRITERIA_WITH_EVIDENCE,
        {
          implementedAt: "2026-09-16",
        },
      );
      const violations = await runValidate(dir, "ADR-9996");
      const av17 = filterRule(violations, "AV-17");
      expect(av17).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
