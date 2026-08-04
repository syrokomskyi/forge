/*
<MODULE_CONTRACT>
<purpose>Trash-can deletion primitive — moves files/directories to the OS
trash/recycle bin instead of permanently deleting them. Uses the `trash`
npm package which implements the FreeDesktop.org Trash specification on
Linux (no external `trash-put` binary required) and the Recycle Bin on
Windows.</purpose>
<non-goals>
  <item>Do not implement trash eviction or retention policies — the OS manages that.</item>
  <item>Do not use for ephemeral cleanup (lock files, temp files, atomic write leftovers) — those are system-internal and should use fs.unlink directly.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation: wraps npm `trash` package with glob disabled for safe path handling.</item>
</CHANGE_SUMMARY>
*/

import { existsSync } from "node:fs";
import trash from "trash";

export async function trashPath(targetPath: string): Promise<void> {
  if (!existsSync(targetPath)) return;
  await trash(targetPath, { glob: false });
}
