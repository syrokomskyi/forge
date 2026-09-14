/*
<MODULE_CONTRACT>
<purpose>
forge.file-size.lint — RFC-1088: portable two-tier severity for .ts/.tsx source files
under packages/** exceeding a line-count threshold. 601-1200 lines → warning (SIZE-01);
above 1200 lines → error (SIZE-01). Autonomous: no @warpgogol/* imports. Inlined
collectFiles and diagnosticsResult. Ratcheted baseline at workspace root.
</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable (FORGE-AUTONOMY-01).</item>
  <item>Do not parse a real AST — a physical line count is sufficient.</item>
  <item>Do not split files — that is a manual action, one file per commit.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1088: initial implementation — ported from packages/werkstatt-site/src/checks/file-size-lint.ts to forge for autonomy.</item>
</CHANGE_SUMMARY>
*/

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type {
  CheckResult,
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const SCAN_ROOT = "packages";
const DEFAULT_BASELINE_PATH = "file-size-lint.baseline.yaml";
const WARNING_THRESHOLD = 600;
const ERROR_THRESHOLD = 1200;

interface FileSizeLintBaseline {
  meta: { schemaVersion: 1; threshold: 600 };
  /** Workspace-relative file path → accepted line-count ceiling (shrink-only). */
  ceilings: Record<string, number>;
}

/** Pure: physical line count of a source string. */
export function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.split("\n").length;
}

/** Inlined recursive file collector — no @warpgogol/werkstatt-shared dependency. */
async function collectSourceFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith("-") || entry.name.startsWith("old-")) continue;
      if (entry.name === "tests" || entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.name === ".astro" || entry.name.endsWith(".d.ts")) continue;
      if (entry.name.endsWith(".generated.yaml")) continue;

      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;

      results.push(full);
    }
  }

  await walk(root);
  return results;
}

async function readBaseline(
  workspaceRoot: string,
  baselinePath: string,
): Promise<FileSizeLintBaseline | undefined> {
  try {
    const raw = await readFile(join(workspaceRoot, baselinePath), "utf8");
    return yamlParse(raw) as FileSizeLintBaseline;
  } catch {
    return undefined;
  }
}

function renderBaseline(ceilings: Record<string, number>): string {
  const baseline: FileSizeLintBaseline = {
    meta: { schemaVersion: 1, threshold: WARNING_THRESHOLD },
    ceilings,
  };
  return yamlStringify(baseline);
}

async function findOversizedFiles(workspaceRoot: string): Promise<Map<string, number>> {
  const files = await collectSourceFiles(join(workspaceRoot, SCAN_ROOT));
  const oversized = new Map<string, number>();
  for (const filePath of files) {
    let source: string;
    try {
      source = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = countLines(source);
    if (lines > WARNING_THRESHOLD) {
      const relFile = relative(workspaceRoot, filePath).replace(/\\/g, "/");
      oversized.set(relFile, lines);
    }
  }
  return oversized;
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
  if (summary.warning > 0) counts.push(`${summary.warning} warning${summary.warning === 1 ? "" : "s"}`);
  const summaryStr = counts.length > 0 ? `[${command}] ${counts.join(", ")}` : `[${command}]`;
  return {
    data: { command, status, diagnostics, summary },
    exitCode: summary.error > 0 ? 1 : 0,
    summary: summaryStr,
    nextSteps:
      summary.error > 0
        ? [
            {
              action: `Fix the error diagnostics reported by ${command} above, then re-run the pipeline`,
              kind: "required" as const,
            },
          ]
        : undefined,
  };
}

export async function runFileSizeLint(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CheckResult | { file: string; files: number }>> {
  const { workspaceRoot } = context;
  const baselinePath =
    (input.flags["baseline-path"] as string | undefined) ?? DEFAULT_BASELINE_PATH;
  const oversized = await findOversizedFiles(workspaceRoot);

  if (input.flags["write-baseline"] === true) {
    const ceilings: Record<string, number> = {};
    for (const [file, lines] of oversized) ceilings[file] = lines;
    await writeFile(join(workspaceRoot, baselinePath), renderBaseline(ceilings), "utf8");
    return {
      data: { file: baselinePath, files: oversized.size },
      exitCode: 0,
      summary: `forge.file-size.lint: wrote ${oversized.size} oversized file(s) to ${baselinePath}`,
    };
  }

  const baseline = await readBaseline(workspaceRoot, baselinePath);
  const ceilings = baseline?.ceilings ?? {};
  const diagnostics: Diagnostic[] = [];

  for (const [file, lines] of oversized) {
    const ceiling = ceilings[file];
    if (ceiling !== undefined && lines <= ceiling) continue;

    const severity: "warning" | "error" = lines > ERROR_THRESHOLD ? "error" : "warning";

    diagnostics.push({
      ruleId: "SIZE-01",
      severity,
      file,
      message:
        ceiling !== undefined
          ? `File grew from the baselined ${ceiling} to ${lines} lines, exceeding the ${WARNING_THRESHOLD}-line threshold.`
          : `New file has ${lines} lines, exceeding the ${WARNING_THRESHOLD}-line threshold.`,
      fixHint:
        "Split the file into a sibling folder-of-files with a thin re-export shim, or shrink the baseline ceiling after review.",
      data: { lines, threshold: WARNING_THRESHOLD, ceiling: ceiling ?? null },
    });
  }

  return diagnosticsResult("forge.file-size.lint", diagnostics);
}
