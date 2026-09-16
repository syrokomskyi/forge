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
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
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
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: targetDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "forge@warpgogol.dev"], {
        cwd: targetDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Forge Migration"], {
        cwd: targetDir,
        stdio: "pipe",
      });
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
        execFileSync("git", ["init", "--initial-branch=main"], { cwd: targetDir, stdio: "pipe" });
      }
    }
  } else {
    if (!fs.existsSync(gitDir)) {
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: targetDir, stdio: "pipe" });
    }
  }
}
