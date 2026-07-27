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
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./fs-atomic.ts";

export async function writeFileIfChanged(
  filePath: string,
  content: string,
): Promise<"written" | "unchanged"> {
  try {
    const existing = await readFile(filePath, "utf8");
    if (existing === content) {
      return "unchanged";
    }
  } catch {
    // File does not exist — proceed to write.
  }
  await writeFileAtomic(filePath, content);
  return "written";
}
