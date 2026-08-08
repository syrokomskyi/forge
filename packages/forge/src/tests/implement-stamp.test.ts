import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runRfcImplementStamp } from "../../os/rfc/handlers/implement-stamp.ts";
import type { ForgeCommandInput, ForgeRuntimeContext, ForgeLogger } from "../../src/types.ts";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const noopLogger: ForgeLogger = {
  section: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
};

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: noopLogger,
    dryRun: false,
    outputFormat: "json",
  };
}

function makeInput(id: string, commit: string, dryRun?: boolean): ForgeCommandInput {
  return {
    argv: [],
    flags: {
      id,
      "implementation-commit": commit,
      ...(dryRun ? { "dry-run": true } : {}),
    },
  };
}

function makeInputAutoDetect(id: string, dryRun?: boolean): ForgeCommandInput {
  return {
    argv: [],
    flags: {
      id,
      ...(dryRun ? { "dry-run": true } : {}),
    },
  };
}

const RFC_BODY = (id: string, status: string, criteriaChecked: boolean): string => `---
id: ${id}
title: "Test RFC"
status: ${status}
kind: policy
scope: workspace
owners:
  - architecture
reviewers:
  - human:test
createdAt: 2026-07-21
updatedAt: 2026-07-21
---

# ${id}: Test RFC

## Context

Test context.

## Problem

Test problem.

## Decision

Test decision.

## Architectural fit

Test fit.

## Design

Test design.

## Rollout

Test rollout.

## Alternatives considered

None.

## Risks

None.

## Acceptance criteria

- [${criteriaChecked ? "x" : " "}] First criterion (evidence: src/foo.ts:10, unit test)
- [${criteriaChecked ? "x" : " "}] Second criterion (evidence: src/bar.ts:20, integration test)
- [${criteriaChecked ? "x" : " "}] Third criterion (evidence: src/baz.ts:30, e2e test)

## Implementation notes for agents

Test notes.
`;

async function makeGitRepo(dir: string): Promise<void> {
  execFileSync("git", ["init"], { cwd: dir, timeout: 5000 });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, timeout: 5000 });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, timeout: 5000 });
}

async function commitAll(dir: string, message: string): Promise<string> {
  execFileSync("git", ["add", "-A"], { cwd: dir, timeout: 5000 });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, timeout: 5000 });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 5000 }).toString().trim();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("rfc.implement.stamp", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "rfc-stamp-test-"));
    await mkdir(join(workspaceRoot, "docs", "rfcs"), { recursive: true });
    await makeGitRepo(workspaceRoot);
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("rejects an RFC not in accepted status (RFC-IMP-01)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "draft", true));
    const commit = await commitAll(workspaceRoot, "Initial commit RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations).toHaveLength(1);
    expect(result.data?.violations[0]?.rule).toBe("RFC-IMP-01");
  });

  it("rejects unchecked criteria (RFC-IMP-02)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", false));
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    const rules = result.data?.violations.map((v) => v.rule);
    expect(rules).toContain("RFC-IMP-02");
  });

  it("rejects an RFC file with uncommitted changes (RFC-IMP-04)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    // Make an uncommitted edit to the RFC file itself
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true) + "\nextra\n");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    const rules = result.data?.violations.map((v) => v.rule);
    expect(rules).toContain("RFC-IMP-04");
  });

  it("ignores uncommitted changes in unrelated files (multi-agent)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    // Create uncommitted files from other agents — must NOT block stamping
    await writeFile(join(workspaceRoot, "dirty.txt"), "dirty");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "other-agent.ts"), "// other agent\n");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations).toEqual([]);
  });

  it("rejects a commit that does not reference the RFC (RFC-IMP-03)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    await commitAll(workspaceRoot, "Add RFC-0001");

    // Make a separate commit that doesn't reference the RFC
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "change.ts"), "// unrelated\n");
    const unrelatedCommit = await commitAll(workspaceRoot, "Some unrelated change");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", unrelatedCommit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    const rules = result.data?.violations.map((v) => v.rule);
    expect(rules).toContain("RFC-IMP-03");
  });

  it("rejects a non-existent RFC (RFC-IMP-01)", async () => {
    // Need at least one file to commit
    await writeFile(join(workspaceRoot, "README.md"), "# test");
    const commit = await commitAll(workspaceRoot, "Initial commit");

    const result = await runRfcImplementStamp(
      makeInput("RFC-9999", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations[0]?.rule).toBe("RFC-IMP-01");
  });

  it("passes in dry-run mode for a valid accepted RFC", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit, true),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.data?.rfcId).toBe("RFC-0001");
    expect(result.data?.data?.criteriaChecked).toBe(3);
    expect(result.data?.violations).toEqual([]);

    // Verify the file was NOT mutated
    const content = await readFile(rfcFile, "utf-8");
    expect(content).toContain("status: accepted");
    expect(content).not.toContain("status: implemented");
  });

  it("atomically stamps a valid accepted RFC to implemented", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", commit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.data?.rfcId).toBe("RFC-0001");
    expect(result.data?.data?.implementationCommit).toBe(commit);
    expect(result.data?.data?.criteriaChecked).toBe(3);
    expect(result.data?.violations).toEqual([]);

    // Verify the file WAS mutated
    const content = await readFile(rfcFile, "utf-8");
    expect(content).toContain("status: implemented");
    expect(content).toMatch(/implementedAt: \d{4}-\d{2}-\d{2}/);
  });

  // ── RFC-0756: auto-detect tests ─────────────────────────────────────────────

  it("auto-detects the implementation commit when --implementation-commit is omitted (RFC-0756)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    const commit = await commitAll(workspaceRoot, "Implement RFC-0001");

    const result = await runRfcImplementStamp(
      makeInputAutoDetect("RFC-0001"),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.data?.rfcId).toBe("RFC-0001");
    expect(result.data?.data?.implementationCommit).toBe(commit);
    expect(result.data?.violations).toEqual([]);

    const content = await readFile(rfcFile, "utf-8");
    expect(content).toContain("status: implemented");
  });

  it("lists multiple candidate commits when auto-detect finds more than one (RFC-0756)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    await commitAll(workspaceRoot, "Implement RFC-0001 step 1");
    await writeFile(join(workspaceRoot, "src.txt"), "step 2");
    await commitAll(workspaceRoot, "Implement RFC-0001 step 2");

    const result = await runRfcImplementStamp(
      makeInputAutoDetect("RFC-0001"),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    const imp03 = result.data?.violations.find((v) => v.rule === "RFC-IMP-03");
    expect(imp03).toBeDefined();
    expect(imp03?.message).toContain("Multiple commits reference RFC-0001");
    expect(imp03?.message).toContain("Pass --implementation-commit");
  });

  it("errors with a clear message when no commit references the RFC (RFC-0756)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    await commitAll(workspaceRoot, "Initial commit without RFC ref");

    const result = await runRfcImplementStamp(
      makeInputAutoDetect("RFC-0001"),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    const imp03 = result.data?.violations.find((v) => v.rule === "RFC-IMP-03");
    expect(imp03).toBeDefined();
    expect(imp03?.message).toContain("No commit referencing RFC-0001 found");
    expect(imp03?.message).toContain("Pass --implementation-commit");
  });

  it("explicit --implementation-commit overrides auto-detect when multiple commits exist (RFC-0756)", async () => {
    const rfcFile = join(workspaceRoot, "docs", "rfcs", "rfc-0001-test-rfc.md");
    await writeFile(rfcFile, RFC_BODY("RFC-0001", "accepted", true));
    await commitAll(workspaceRoot, "Implement RFC-0001 step 1");
    await writeFile(join(workspaceRoot, "src.txt"), "step 2");
    const secondCommit = await commitAll(workspaceRoot, "Implement RFC-0001 step 2");

    const result = await runRfcImplementStamp(
      makeInput("RFC-0001", secondCommit),
      makeContext(workspaceRoot),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.data?.implementationCommit).toBe(secondCommit);
    expect(result.data?.violations).toEqual([]);
  });
});
