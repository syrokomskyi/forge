import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
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
    execSync(
      `GIT_AUTHOR_DATE="${c.date}" GIT_COMMITTER_DATE="${c.date}" git commit --allow-empty -m "${c.message}"`,
      { cwd: dir, timeout: 5000 },
    );
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
