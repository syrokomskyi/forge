/*
<MODULE_CONTRACT>
<purpose>
rules.budget.check — RFC-1522: byte-budget gate for always-on rule files
(AGENTS.md / CLAUDE.md / .windsurfrules) under the workspace root. Files over
the budget exit the IDE's rule-injection window — every excess byte is a
RULES-BUDGET-01 error diagnostic; the command exits 1 on any overage so
ecosystem.commit/CI can gate regrowth. Autonomous: no @warpgogol/* imports.
Inlined collectFiles and diagnosticsResult.
</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable (FORGE-AUTONOMY-01).</item>
  <item>Do not scan invoked-on-demand skill files (SKILL.md) — a different injection class, owned by skill.validate if ever needed.</item>
  <item>Do not scan fixture/test/mission/docs trees — their markdown is content, not rule surface.</item>
  <item>Do not slim files — extraction into docs/agent-guides/ is a manual action.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1522: initial implementation — RULES-BUDGET-01 over-budget diagnostics, RULES-BUDGET-02 usage errors.</item>
  <item>RFC-1522: add rules.budget.check byte-budget gate for always-on rule files

RULES-BUDGET-01 flags AGENTS.md/CLAUDE.md/.windsurfrules over 12288 bytes (fixture/test/mission/docs trees excluded); RULES-BUDGET-02 rejects non-positive-integer --budget. The gate goes red on the 8 over-budget files the RFC-1522 slimming addresses next.</item>
</CHANGE_SUMMARY>
*/

import { join, relative } from "node:path";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;
import type {
  CheckResult,
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export const DEFAULT_BUDGET_BYTES = 12_288;

const RULE_FILE_NAMES = new Set(["AGENTS.md", "CLAUDE.md", ".windsurfrules"]);

// Directory names whose markdown is content, not agent-facing rule surface.
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "missions",
  "fixtures",
  "tests",
  "docs",
  "out",
  "coverage",
  "build",
]);

/** Pure: does this path entry name carry rule-file status? */
export function isRuleFileName(name: string): boolean {
  return RULE_FILE_NAMES.has(name);
}

/** Pure: is this directory part of the scan (not excluded, not a dot-dir)? */
export function isScannableDir(name: string): boolean {
  return !name.startsWith(".") && !EXCLUDED_DIRS.has(name);
}

/** Inlined recursive rule-file collector — no @warpgogol/werkstatt-shared dependency. */
async function collectRuleFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  // fs.walk.lint: allow — walks via WorkspaceIO abstraction (io.readdir), not node fs — collectFiles has no io contract
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await io.readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        if (isScannableDir(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile) continue;
      if (!isRuleFileName(entry.name)) continue;
      results.push(full);
    }
  }

  await walk(root);
  return results;
}

/** Inlined diagnosticsResult — constructs a CheckResult from Diagnostic[]. */
function diagnosticsResult(
  command: string,
  diagnostics: Diagnostic[],
): ForgeCommandResult<CheckResult> {
  const summary = {
    error: diagnostics.filter((d) => d.severity === "error").length,
    warning: diagnostics.filter((d) => d.severity === "warning").length,
    info: diagnostics.filter((d) => d.severity === "info").length,
  };
  const status: CheckResult["status"] =
    summary.error > 0 ? "fail" : summary.warning > 0 ? "warn" : "pass";
  const counts: string[] = [];
  if (summary.error > 0) counts.push(`${summary.error} error${summary.error === 1 ? "" : "s"}`);
  if (summary.warning > 0)
    counts.push(`${summary.warning} warning${summary.warning === 1 ? "" : "s"}`);
  const summaryStr = counts.length > 0 ? `[${command}] ${counts.join(", ")}` : `[${command}]`;
  return {
    data: { command, status, diagnostics, summary },
    exitCode: summary.error > 0 ? 1 : 0,
    summary: summaryStr,
    nextSteps:
      summary.error > 0
        ? [
            {
              action: `Fix the error diagnostics reported by ${command} above, then re-run the check`,
              kind: "required" as const,
            },
          ]
        : undefined,
  };
}

function resolveBudget(raw: unknown): { budget: number; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { budget: DEFAULT_BUDGET_BYTES };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { budget: DEFAULT_BUDGET_BYTES, error: String(raw) };
  }
  return { budget: n };
}

export async function runRulesBudgetCheck(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CheckResult>> {
  const io = resolveIo(context.io);
  const { workspaceRoot } = context;
  const command = "rules.budget.check";

  const { budget, error } = resolveBudget(input.flags["budget"]);
  if (error !== undefined) {
    return diagnosticsResult(command, [
      {
        ruleId: "RULES-BUDGET-02",
        severity: "error",
        message: `--budget must be a positive integer byte count (got "${error}").`,
        data: { budget: error },
      },
    ]);
  }

  const files = await collectRuleFiles(workspaceRoot);
  const diagnostics: Diagnostic[] = [];

  for (const filePath of files) {
    let source: string;
    try {
      source = await io.readFile(filePath);
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(source, "utf8");
    if (bytes <= budget) continue;
    const relFile = relative(workspaceRoot, filePath).replace(/\\/g, "/");
    diagnostics.push({
      ruleId: "RULES-BUDGET-01",
      severity: "error",
      file: relFile,
      message: `File is ${bytes} bytes, exceeding the ${budget}-byte rule-file budget. Extract depth topics into docs/agent-guides/<topic>.md and keep the skeleton lean (RFC-1522).`,
      data: { bytes, budget },
    });
  }

  return diagnosticsResult(command, diagnostics);
}
