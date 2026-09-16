/*
<MODULE_CONTRACT>
<purpose>Trivial hash utility — inlined from @warpgogol/fingerprint to avoid dependency.</purpose>
<non-goals>
  <item>Do not add non-hash utilities here — use dedicated utility modules.</item>
  <item>Do not introduce @warpgogol/* imports — this package must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The hash helper is an inlined copy — one function does not justify a package dependency.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into <history>, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";

export function byteHash(bytes: Uint8Array | string): string {
  const input = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
