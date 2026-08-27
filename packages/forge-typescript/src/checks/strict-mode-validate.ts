/*
<MODULE_CONTRACT>
<purpose>ts.strict.mode.validate — validates strict-mode conventions: unescaped any, missing return types, unjustified @ts-ignore (TS-005, RFC-0889).</purpose>
<keywords>strict, mode, validate, any, ts-ignore, typescript</keywords>
<non-goals>
  <item>Does not modify source files — read-only validator.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial strict mode validator.</item>
</CHANGE_SUMMARY>
*/

import type {
  KernelCommandDefinition,
  KernelCommandResult,
  Diagnostic,
} from "@warpgogol/werkstatt-engine/kernel/types";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { makeDiagnostic, emptySummary, buildSummary } from "./diagnostic-helpers.ts";

export interface StrictModeValidateData {
  command: string;
  status: "pass" | "warn" | "fail";
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
}

const ANY_TYPE_PATTERN = /:\s*any\b/g;
const TS_IGNORE_PATTERN = /@ts-ignore/g;
const EXPORTED_FUNCTION_PATTERN =
  /^export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{{=]+)?\s*[{=]/gm;

async function scanTsFilesForStrictMode(
  dir: string,
  workspaceRoot: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      await scanTsFilesForStrictMode(fullPath, workspaceRoot, diagnostics);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      const relPath = relative(workspaceRoot, fullPath);
      if (
        relPath.includes("/__tests__/") ||
        relPath.endsWith(".test.ts") ||
        relPath.endsWith(".spec.ts")
      ) {
        continue;
      }

      let content: string;
      try {
        content = await readFile(fullPath, "utf8");
      } catch {
        continue;
      }

      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        const anyMatches = line.match(ANY_TYPE_PATTERN);
        if (anyMatches) {
          if (!line.includes("eslint-disable") && !line.includes("// @ts-expect-error")) {
            diagnostics.push(
              makeDiagnostic(
                "TS-STRICT-01",
                "warning",
                `Unescaped "any" type found. Use "unknown" or add eslint-disable comment if intentional.`,
                relPath,
                lineNumber,
              ),
            );
          }
        }

        if (TS_IGNORE_PATTERN.test(line)) {
          const nextLine = lines[i + 1] ?? "";
          if (!nextLine.trim().startsWith("//") && !line.includes("reason:")) {
            diagnostics.push(
              makeDiagnostic(
                "TS-STRICT-02",
                "warning",
                "@ts-ignore without justification comment. Add a comment explaining why the error is suppressed.",
                relPath,
                lineNumber,
              ),
            );
          }
        }
      }

      EXPORTED_FUNCTION_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = EXPORTED_FUNCTION_PATTERN.exec(content)) !== null) {
        const lineNum = content.slice(0, match.index).split("\n").length;
        const fullMatch = match[0];
        if (!fullMatch.includes(":")) {
          diagnostics.push(
            makeDiagnostic(
              "TS-STRICT-03",
              "warning",
              `Exported function "${match[1]}" missing explicit return type. All exported functions should declare their return type.`,
              relPath,
              lineNum,
            ),
          );
        }
      }
    }
  }
}

export async function runStrictModeValidate(
  workspaceRoot: string,
): Promise<KernelCommandResult<StrictModeValidateData>> {
  const diagnostics: Diagnostic[] = [];

  const packagesDir = join(workspaceRoot, "packages");
  try {
    await stat(packagesDir);
  } catch {
    return {
      data: {
        command: "ts.strict.mode.validate",
        status: "pass",
        diagnostics: [],
        summary: emptySummary(),
      },
      exitCode: 0,
      summary: "ts.strict.mode.validate: pass (no packages directory)",
    };
  }

  await scanTsFilesForStrictMode(packagesDir, workspaceRoot, diagnostics);

  const summary = buildSummary(diagnostics);
  const status = summary.error > 0 ? "fail" : summary.warning > 0 ? "warn" : "pass";

  return {
    data: { command: "ts.strict.mode.validate", status, diagnostics, summary },
    exitCode: summary.error > 0 ? 1 : 0,
    summary: `ts.strict.mode.validate: ${status} (${summary.error} error(s), ${summary.warning} warning(s))`,
  };
}

export function createStrictModeValidateCommand(): KernelCommandDefinition<StrictModeValidateData> {
  return {
    name: "ts.strict.mode.validate",
    description:
      "Validate strict-mode conventions: unescaped any, missing return types on exported functions, unjustified @ts-ignore (TS-005).",
    scope: "workspace",
    cacheable: true,
    supportsAllSites: false,
    reads: ["packages/**/*.ts", "packages/**/*.tsx"],
    async execute(_input, context) {
      return runStrictModeValidate(context.workspaceRoot);
    },
  };
}
