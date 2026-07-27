/*
<MODULE_CONTRACT>
<purpose>Trivial hash utility — inlined from @warpgogol/fingerprint to avoid dependency.</purpose>
<non-goals>
  <item>Do not add non-hash utilities here — use dedicated utility modules.</item>
  <item>Do not introduce @warpgogol/* imports — this package must remain dependency-free.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial inline of byteHash from @warpgogol/fingerprint/primitives.</item>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";

export function byteHash(bytes: Uint8Array | string): string {
  const input = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
