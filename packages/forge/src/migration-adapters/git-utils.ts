/*
<MODULE_CONTRACT>
<purpose>Shared git utilities for migration adapters — git init and git history transfer via format-patch + git am (RFC-0547).</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not implement adapter-specific logic — only shared git operations.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0547: extract shared postSetup git logic from duplicated adapter implementations.</item>
  <item>Replace fs.rmSync with trashSync for patch directory cleanup (trash bin for LLM-initiated deletions).</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { trashSync } from "../utils/fs-trash-sync.ts";
import type { AdapterAnalysis } from "./types.ts";

export function runPostSetup(
  sourceDir: string,
  targetDir: string,
  analysis: AdapterAnalysis,
): void {
  const gitDir = path.join(targetDir, ".git");

  if (analysis.gitHistory) {
    try {
      const patchDir = path.join(targetDir, ".forge-migration-patches");
      fs.mkdirSync(patchDir, { recursive: true });
      execFileSync("git", ["-C", sourceDir, "format-patch", "--all", "-o", patchDir], {
        stdio: "pipe",
      });
      execFileSync("git", ["init"], { cwd: targetDir, stdio: "pipe" });
      const patches = fs
        .readdirSync(patchDir)
        .filter((f) => f.endsWith(".patch"))
        .sort();
      if (patches.length > 0) {
        for (const patch of patches) {
          execFileSync("git", ["am", path.join(patchDir, patch)], {
            cwd: targetDir,
            stdio: "pipe",
          });
        }
      }
      trashSync(patchDir);
      return;
    } catch (err) {
      console.warn(
        `forge: git history transfer failed, falling back to clean git init: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!fs.existsSync(gitDir)) {
        execFileSync("git", ["init"], { cwd: targetDir, stdio: "pipe" });
      }
    }
  } else {
    if (!fs.existsSync(gitDir)) {
      execFileSync("git", ["init"], { cwd: targetDir, stdio: "pipe" });
    }
  }
}
