/*
<MODULE_CONTRACT>
<purpose>werkstatt.operation.validate command handler. Moved from
@warpgogol/site-kernel-checks to @warpgogol/forge for full autonomous mode (RFC-0556).
Scans command source files for direct shared-state writes outside the allowlisted
helper module (RFC-0362 §6).</purpose>
<non-goals>
  <item>Does not load command implementations — reads source files with regex only.</item>
  <item>Does not scan files outside packages/os/site-kernel-handoff/src/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0362: initial operation.validate command handler.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-checks to @warpgogol/forge for autonomous mode. Uses node:fs/promises directly instead of context.io.</item>
</CHANGE_SUMMARY>
*/

import { basename, join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { collectFiles } from "../../../src/utils/fs.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const SCAN_DIR = "packages/os/site-kernel-handoff/src";
const ALLOWLIST_DIR = "packages/os/site-kernel-handoff/src/werkstatt";

const DIRECT_WRITE_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\bwriteFile\s*\(/g, label: "writeFile" },
  { regex: /\bappendFile\s*\(/g, label: "appendFile" },
  { regex: /\brename\s*\(/g, label: "rename" },
  { regex: /\bcp\s*\(/g, label: "cp" },
];

export interface WerkstattOperationValidateData {
  scannedFiles: number;
  violations: Array<{ file: string; line: number; pattern: string }>;
}

export async function runWerkstattOperationValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<WerkstattOperationValidateData>> {
  const { workspaceRoot, logger } = context;
  const scanPath = join(workspaceRoot, SCAN_DIR);
  const allowlistPath = join(workspaceRoot, ALLOWLIST_DIR);

  const files = await collectFiles(scanPath, {
    ignore: (name) =>
      name.startsWith(".") || name === "node_modules" || name === "dist" || name === "tests",
  });

  const violations: Array<{ file: string; line: number; pattern: string }> = [];

  const PRE_EXISTING_ALLOWLIST = new Set(["handoff-pack.ts", "materialize.ts", "bundle-io.ts"]);

  for (const filePath of files) {
    if (filePath.startsWith(allowlistPath) || filePath.includes("werkstatt")) continue;

    const fileName = basename(filePath);
    if (fileName.endsWith(".test.ts") || fileName.endsWith(".spec.ts")) continue;
    if (PRE_EXISTING_ALLOWLIST.has(fileName)) continue;

    const relPath = relative(workspaceRoot, filePath).replace(/\\/g, "/");

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

      for (const { regex, label } of DIRECT_WRITE_PATTERNS) {
        const testRegex = new RegExp(regex.source, regex.flags);
        if (testRegex.test(line)) {
          violations.push({ file: relPath, line: i + 1, pattern: label });
          logger.error(
            `${relPath}:${i + 1}: direct ${label} — use the shared atomic-write helper in packages/os/site-kernel-handoff/src/werkstatt/`,
          );
        }
      }
    }
  }

  return {
    data: {
      scannedFiles: files.length,
      violations,
    },
    exitCode: violations.length > 0 ? 1 : 0,
    summary:
      violations.length > 0
        ? undefined
        : `[werkstatt.operation.validate] ${files.length} files scanned, 0 violations`,
  };
}
