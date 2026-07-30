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
<CHANGE_SUMMARY>
  <item>RFC-0556: moved from @warpgogol/site-kernel/fs-idempotent to forge as canonical source (dependency inversion).</item>
  <item>RFC-0603: extended to accept Uint8Array (Buffer) content for idempotent binary file writes — PNG preview images.</item>
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
