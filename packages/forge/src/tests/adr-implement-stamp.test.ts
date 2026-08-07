import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runAdrImplementStamp } from "../../os/adr/handlers/implement-stamp.ts";
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

const ADR_BODY = (id: string, status: string): string => `---
id: ${id}
title: "Test ADR"
status: ${status}
scope: workspace
decider: human:test
createdAt: 2026-08-01
updatedAt: 2026-08-01
---

# ${id}: Test ADR

## Context

Test context.

## Decision

Test decision.

## Justification

Test justification.

## Consequences

Test consequences.

## Evolution

Test evolution.
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

describe("adr.implement.stamp", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "adr-stamp-test-"));
    await mkdir(join(workspaceRoot, "docs", "adrs"), { recursive: true });
    await makeGitRepo(workspaceRoot);
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // ── ADR-IMP-01: status checks ───────────────────────────────────────────────

  it("rejects ADR with status superseded", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "superseded"),
    );
    const sha = await commitAll(workspaceRoot, "initial");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.some((v) => v.rule === "ADR-IMP-01")).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("rejects ADR with status reviewing", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "reviewing"),
    );
    const sha = await commitAll(workspaceRoot, "initial");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.some((v) => v.rule === "ADR-IMP-01")).toBe(true);
  });

  it("rejects ADR with status implemented (already done)", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "implemented"),
    );
    const sha = await commitAll(workspaceRoot, "initial");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.some((v) => v.rule === "ADR-IMP-01")).toBe(true);
  });

  it("rejects ADR not found", async () => {
    await writeFile(join(workspaceRoot, "dummy.txt"), "test");
    const sha = await commitAll(workspaceRoot, "initial");

    const result = await runAdrImplementStamp(
      makeInput("ADR-9999", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.some((v) => v.rule === "ADR-IMP-01")).toBe(true);
  });

  // ── ADR-IMP-03: commit validation ───────────────────────────────────────────

  it("rejects commit not reachable from HEAD", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "accepted"),
    );
    await commitAll(workspaceRoot, "initial commit ADR-0001");

    // Create a divergent commit
    await writeFile(join(workspaceRoot, "dummy.txt"), "test");
    const sha1 = await commitAll(workspaceRoot, "first");
    execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: workspaceRoot, timeout: 5000 });
    await writeFile(join(workspaceRoot, "other.txt"), "test");
    await commitAll(workspaceRoot, "second");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha1),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.some((v) => v.rule === "ADR-IMP-03")).toBe(true);
  });

  it("rejects commit that does not reference ADR id", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "accepted"),
    );
    await commitAll(workspaceRoot, "add ADR");

    await writeFile(join(workspaceRoot, "code.ts"), "console.log('hello');");
    const sha = await commitAll(workspaceRoot, "add code without ADR reference");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.some((v) => v.rule === "ADR-IMP-03")).toBe(true);
  });

  it("passes when commit message references ADR id", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "accepted"),
    );
    await commitAll(workspaceRoot, "add ADR-0001");

    await writeFile(join(workspaceRoot, "code.ts"), "console.log('hello');");
    const sha = await commitAll(workspaceRoot, "implement: ADR-0001 add feature");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("pass");
    expect(result.exitCode).toBe(0);
  });

  it("passes when commit changed files contain ADR slug", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "accepted"),
    );
    await commitAll(workspaceRoot, "add ADR-0001");

    // Commit touches the ADR file itself (slug "adr-0001" is in the path)
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "accepted") + "\n<!-- update -->\n",
    );
    const sha = await commitAll(workspaceRoot, "update adr-0001 file");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("pass");
  });

  // ── ADR-IMP-04: file cleanliness ─────────────────────────────────────────────

  it("rejects when ADR file has uncommitted changes", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "accepted"),
    );
    const sha = await commitAll(workspaceRoot, "add ADR-0001");

    // Make uncommitted change to the ADR file
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "accepted") + "\n<!-- dirty -->\n",
    );

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.some((v) => v.rule === "ADR-IMP-04")).toBe(true);
  });

  // ── ADR-IMP-05: concurrent lock ──────────────────────────────────────────────

  it("rejects when a concurrent lock is held", async () => {
    await writeFile(
      join(workspaceRoot, "docs", "adrs", "adr-0001-test.md"),
      ADR_BODY("ADR-0001", "accepted"),
    );
    const sha = await commitAll(workspaceRoot, "implement: ADR-0001 add feature");

    // Pre-create the lock file to simulate a concurrent stamp
    await mkdir(join(workspaceRoot, ".adr-locks"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".adr-locks", "adr-0001.lock"),
      JSON.stringify({ pid: 99999, acquiredAt: new Date().toISOString() }),
    );

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.some((v) => v.rule === "ADR-IMP-05")).toBe(true);
  });

  // ── Dry-run ──────────────────────────────────────────────────────────────────

  it("dry-run checks preconditions without mutating file", async () => {
    const adrPath = join(workspaceRoot, "docs", "adrs", "adr-0001-test.md");
    await writeFile(adrPath, ADR_BODY("ADR-0001", "accepted"));
    await commitAll(workspaceRoot, "add ADR-0001");

    await writeFile(join(workspaceRoot, "code.ts"), "console.log('hello');");
    const sha = await commitAll(workspaceRoot, "implement: ADR-0001 add feature");

    const originalContent = await readFile(adrPath, "utf-8");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha, true),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("pass");
    expect(result.data?.data?.adrId).toBe("ADR-0001");

    // File should not be mutated
    const afterContent = await readFile(adrPath, "utf-8");
    expect(afterContent).toBe(originalContent);
  });

  // ── Atomic stamp: accepted → implemented ─────────────────────────────────────

  it("atomically stamps accepted ADR as implemented", async () => {
    const adrPath = join(workspaceRoot, "docs", "adrs", "adr-0001-test.md");
    await writeFile(adrPath, ADR_BODY("ADR-0001", "accepted"));
    await commitAll(workspaceRoot, "add ADR-0001");

    await writeFile(join(workspaceRoot, "code.ts"), "console.log('hello');");
    const sha = await commitAll(workspaceRoot, "implement: ADR-0001 add feature");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0001", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("pass");
    expect(result.data?.data?.adrId).toBe("ADR-0001");
    expect(result.data?.data?.implementationCommit).toBe(sha);
    expect(result.exitCode).toBe(0);

    // Verify file was mutated
    const afterContent = await readFile(adrPath, "utf-8");
    expect(afterContent).toContain("status: implemented");
    expect(afterContent).toContain("implementedAt:");
    expect(afterContent).toContain("updatedAt:");
  });

  // ── Post-hoc ADR: proposed → implemented ─────────────────────────────────────

  it("stamps proposed ADR as implemented (post-hoc)", async () => {
    const adrPath = join(workspaceRoot, "docs", "adrs", "adr-0002-test.md");
    await writeFile(adrPath, ADR_BODY("ADR-0002", "proposed"));
    const sha = await commitAll(workspaceRoot, "add ADR-0002");

    const result = await runAdrImplementStamp(
      makeInput("ADR-0002", sha),
      makeContext(workspaceRoot),
    );

    expect(result.data?.status).toBe("pass");
    expect(result.data?.data?.adrId).toBe("ADR-0002");

    const afterContent = await readFile(adrPath, "utf-8");
    expect(afterContent).toContain("status: implemented");
  });
});
