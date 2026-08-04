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
<CHANGE_SUMMARY>
  <item>Initial implementation: sync wrapper for `trash-put` (Linux/macOS) and PowerShell Recycle Bin (Windows).</item>
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
