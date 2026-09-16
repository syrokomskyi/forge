/*
<MODULE_CONTRACT>
<purpose>Synchronous trash-can deletion — shells out to `trash-put` (trash-cli)
on Linux/macOS and PowerShell Recycle Bin on Windows. Used by synchronous
code paths that cannot use the async `trash` npm package.</purpose>
<non-goals>
  <item>Do not use for async code paths — use trashPath from fs-trash.ts instead.</item>
  <item>Requires `trash-put` (trash-cli) installed on Linux/macOS. On Windows, uses PowerShell Recycle Bin API (no external binary needed).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>A synchronous shell-out exists only for call sites that cannot await — sync is a constraint, not a preference.</item>
  <item>Windows goes through the PowerShell Recycle Bin API so no external binary is required there.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
</CHANGE_SUMMARY>
*/

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function trashSync(targetPath: string): void {
  if (!existsSync(targetPath)) return;
  if (process.platform === "win32") {
    const isDir = statSync(targetPath).isDirectory();
    const method = isDir ? "DeleteDirectory" : "DeleteFile";
    const escaped = targetPath.replace(/'/g, "''");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
      ],
      { stdio: "pipe" },
    );
  } else {
    execFileSync("trash-put", [targetPath], { stdio: "pipe" });
  }
}
