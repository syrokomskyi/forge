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
<KEY_DECISIONS>
  <item>Deletion targets the OS trash or recycle bin — recoverability is the contract, never permanent unlink.</item>
  <item>The trash npm package is preferred over shelling out to trash-put on Linux.</item>
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

import { existsSync } from "node:fs";

export async function trashPath(targetPath: string): Promise<void> {
  if (!existsSync(targetPath)) return;
  const { default: trash } = await import("trash");
  await trash(targetPath, { glob: false });
}
