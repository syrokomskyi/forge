/*
<MODULE_CONTRACT>
<purpose>
Unit tests for runAdrCreate — the --related flag must land in the created
ADR's frontmatter across every template shape (F-0005).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>F-0005: --related flag honored across `related: []`, bare `related:`, and seeded-list template shapes</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAdrCreate } from "./list-create.ts";
import type { ForgeCommandInput, ForgeFlagValue, ForgeRuntimeContext } from "../../../src/types.ts";

const execFileAsync = promisify(execFile);

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
}

function makeInput(flags: Record<string, ForgeFlagValue>): ForgeCommandInput {
  return { argv: [], flags };
}

async function git(dir: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: dir });
}

const TEMPLATE_FM = `---
id: ADR-0000
title: "Short imperative title"
status: proposed
scope: package
decider: architecture
createdAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
implementedAt:
closedAt:
supersedes: []
supersededBy:
RELATED_FIELD
reviewers: []
---

# ADR-0000: Short imperative title

## Context

ctx

## Decision

dec

## Consequences

con
`;

/**
 * Scaffold a git repo with docs/adrs/adr-0000-template.md where the
 * `related:` field takes the given template shape.
 */
async function makeRepo(relatedField: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forge-adr-create-test-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await mkdir(join(dir, "docs", "adrs"), { recursive: true });
  await writeFile(
    join(dir, "docs", "adrs", "adr-0000-template.md"),
    TEMPLATE_FM.replace("RELATED_FIELD", relatedField),
  );
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("runAdrCreate --related (F-0005)", () => {
  test("writes related ids when the template ships `related: []`", async () => {
    const dir = await makeRepo("related: []");
    try {
      const result = await runAdrCreate(
        makeInput({ title: "Use X", related: "RFC-0365,ADR-0001" }),
        makeContext(dir),
      );
      expect(result.data?.status).toBe("ok");
      const content = await readFile(join(dir, result.data!.file!), "utf8");
      expect(content).toMatch(/related:\n {2}- RFC-0365\n {2}- ADR-0001/);
      expect(content).not.toContain("related: []");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes related ids when the template ships a bare `related:`", async () => {
    const dir = await makeRepo("related:");
    try {
      const result = await runAdrCreate(
        makeInput({ title: "Use X", related: "RFC-0001" }),
        makeContext(dir),
      );
      expect(result.data?.status).toBe("ok");
      const content = await readFile(join(dir, result.data!.file!), "utf8");
      expect(content).toMatch(/related:\n {2}- RFC-0001\n/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("replaces a seeded `related:\\n  - RFC-0001` list", async () => {
    const dir = await makeRepo("related:\n  - RFC-0001");
    try {
      const result = await runAdrCreate(
        makeInput({ title: "Use X", related: "RFC-0002" }),
        makeContext(dir),
      );
      expect(result.data?.status).toBe("ok");
      const content = await readFile(join(dir, result.data!.file!), "utf8");
      expect(content).toMatch(/related:\n {2}- RFC-0002\n/);
      expect(content).not.toContain("- RFC-0001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("normalizes lowercase and unpadded ids", async () => {
    const dir = await makeRepo("related: []");
    try {
      const result = await runAdrCreate(
        makeInput({ title: "Use X", related: "rfc-365,adr-1" }),
        makeContext(dir),
      );
      expect(result.data?.status).toBe("ok");
      const content = await readFile(join(dir, result.data!.file!), "utf8");
      expect(content).toMatch(/related:\n {2}- RFC-0365\n {2}- ADR-0001/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no --related flag leaves `related: []`", async () => {
    const dir = await makeRepo("related: []");
    try {
      const result = await runAdrCreate(makeInput({ title: "Use X" }), makeContext(dir));
      expect(result.data?.status).toBe("ok");
      const content = await readFile(join(dir, result.data!.file!), "utf8");
      expect(content).toContain("related: []");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
