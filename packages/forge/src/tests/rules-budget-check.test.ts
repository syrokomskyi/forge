/*
<MODULE_CONTRACT>
<purpose>
Unit tests for rules.budget.check covering the byte-budget gate for
always-on rule files (RFC-1522): AGENTS.md / CLAUDE.md / .windsurfrules.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1522: initial tests — over/under budget, custom --budget, usage error, scan-set exclusions.</item>
  <item>RFC-1522: add rules.budget.check byte-budget gate for always-on rule files

RULES-BUDGET-01 flags AGENTS.md/CLAUDE.md/.windsurfrules over 12288 bytes (fixture/test/mission/docs trees excluded); RULES-BUDGET-02 rejects non-positive-integer --budget. The gate goes red on the 8 over-budget files the RFC-1522 slimming addresses next.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRulesBudgetCheck } from "../../os/core/handlers/rules-budget-check.ts";
import type {
  ForgeRuntimeContext,
  ForgeLogger,
  ForgeCommandInput,
  ForgeFlagValue,
} from "../types.ts";

const logger: ForgeLogger = {
  section() {},
  info() {},
  warn() {},
  error() {},
  success() {},
};

function mockContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger,
    dryRun: false,
    outputFormat: "json",
  };
}

function input(flags: Record<string, ForgeFlagValue> = {}): ForgeCommandInput {
  return { argv: [], flags };
}

interface Diag {
  ruleId: string;
  severity: string;
  file: string;
}

function diags(result: { data?: unknown }): Diag[] {
  return ((result.data ?? {}) as { diagnostics?: Diag[] }).diagnostics ?? [];
}

const BIG = "x".repeat(20_000);
const SMALL = "# Guide\n- keep it lean\n";

describe("runRulesBudgetCheck (RFC-1522)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "forge-rules-budget-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("RULES-BUDGET-01: flags an over-budget AGENTS.md with error severity and exit 1", async () => {
    await writeFile(join(tempDir, "AGENTS.md"), BIG, "utf8");

    const result = await runRulesBudgetCheck(input(), mockContext(tempDir));
    expect(result.exitCode).toBe(1);

    const hit = diags(result).find((d) => d.ruleId === "RULES-BUDGET-01");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.file).toBe("AGENTS.md");
  });

  it("RULES-BUDGET-01: flags CLAUDE.md and .windsurfrules too", async () => {
    await writeFile(join(tempDir, "CLAUDE.md"), BIG, "utf8");
    await mkdir(join(tempDir, "pkg"), { recursive: true });
    await writeFile(join(tempDir, "pkg", ".windsurfrules"), BIG, "utf8");

    const result = await runRulesBudgetCheck(input(), mockContext(tempDir));
    expect(result.exitCode).toBe(1);

    const files = diags(result)
      .filter((d) => d.ruleId === "RULES-BUDGET-01")
      .map((d) => d.file)
      .sort();
    expect(files).toEqual(["CLAUDE.md", "pkg/.windsurfrules"]);
  });

  it("passes without diagnostics when every rule file is under budget", async () => {
    await writeFile(join(tempDir, "AGENTS.md"), SMALL, "utf8");
    await mkdir(join(tempDir, "packages", "forge"), { recursive: true });
    await writeFile(join(tempDir, "packages", "forge", "AGENTS.md"), SMALL, "utf8");
    await writeFile(join(tempDir, ".windsurfrules"), SMALL, "utf8");

    const result = await runRulesBudgetCheck(input(), mockContext(tempDir));
    expect(result.exitCode ?? 0).toBe(0);
    expect(diags(result).length).toBe(0);
  });

  it("--budget narrows the threshold", async () => {
    await writeFile(join(tempDir, "AGENTS.md"), "x".repeat(600), "utf8");

    const within = await runRulesBudgetCheck(input(), mockContext(tempDir));
    expect(within.exitCode ?? 0).toBe(0);

    const over = await runRulesBudgetCheck(input({ budget: "512" }), mockContext(tempDir));
    expect(over.exitCode).toBe(1);
    expect(diags(over).some((d) => d.ruleId === "RULES-BUDGET-01")).toBe(true);
  });

  it("RULES-BUDGET-02: unparseable --budget is a blocking usage error", async () => {
    const result = await runRulesBudgetCheck(input({ budget: "abc" }), mockContext(tempDir));
    expect(result.exitCode).toBe(1);
    expect(diags(result).some((d) => d.ruleId === "RULES-BUDGET-02")).toBe(true);
  });

  it("RULES-BUDGET-02: --budget below 1 is a blocking usage error", async () => {
    const result = await runRulesBudgetCheck(input({ budget: "0" }), mockContext(tempDir));
    expect(result.exitCode).toBe(1);
    expect(diags(result).some((d) => d.ruleId === "RULES-BUDGET-02")).toBe(true);
  });

  it("does not scan fixtures, tests, missions, node_modules, docs, or dot-dirs", async () => {
    for (const dir of [
      join("packages", "x", "src", "fixtures", "case"),
      join("packages", "x", "src", "tests"),
      join("missions", "m000001", "workpiece"),
      join("node_modules", "dep"),
      join("docs", "agent-guides"),
      join(".agents", "skills", "s"),
    ]) {
      await mkdir(join(tempDir, dir), { recursive: true });
      await writeFile(join(tempDir, dir, "AGENTS.md"), BIG, "utf8");
    }
    await writeFile(join(tempDir, "AGENTS.md"), SMALL, "utf8");

    const result = await runRulesBudgetCheck(input(), mockContext(tempDir));
    expect(result.exitCode ?? 0).toBe(0);
    expect(diags(result).length).toBe(0);
  });

  it("does not scan non-rule markdown files", async () => {
    await mkdir(join(tempDir, "docs", "agent-guides"), { recursive: true });
    await writeFile(join(tempDir, "docs", "agent-guides", "mirror-sync.md"), BIG, "utf8");
    await writeFile(join(tempDir, "README.md"), BIG, "utf8");

    const result = await runRulesBudgetCheck(input(), mockContext(tempDir));
    expect(result.exitCode ?? 0).toBe(0);
    expect(diags(result).length).toBe(0);
  });
});
