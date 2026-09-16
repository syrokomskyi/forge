/*
<MODULE_CONTRACT>
<purpose>Idempotent file-write primitive — canonical forge utility. Writes only
when file content differs, delegating to writeFileAtomic for the actual write.
Reduces unnecessary disk writes and git churn in Compass and Werkstatt commands.</purpose>
<non-goals>
  <item>Do not provide cross-process locks — convergent atomic writes are sufficient.</item>
  <item>Do not fall back to non-atomic writes — fail loudly.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Content is compared before writing — unchanged files cost zero disk I/O and zero git churn.</item>
  <item>Idempotency composes on writeFileAtomic rather than reimplementing atomic writes.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-0556: moved from @warpgogol/site-kernel/fs-idempotent to forge as canonical source (dependency inversion).</item>
  <item>RFC-0603: extended to accept Uint8Array (Buffer) content for idempotent binary file writes — PNG preview images.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./fs-atomic.ts";

export async function writeFileIfChanged(
  filePath: string,
  content: string | Uint8Array,
): Promise<"written" | "unchanged"> {
  try {
    if (typeof content === "string") {
      const existing = await readFile(filePath, "utf8");
      if (existing === content) {
        return "unchanged";
      }
    } else {
      const existing = await readFile(filePath);
      if (Buffer.compare(existing, Buffer.from(content)) === 0) {
        return "unchanged";
      }
    }
  } catch {
    // File does not exist — proceed to write.
  }
  await writeFileAtomic(filePath, content);
  return "written";
}
