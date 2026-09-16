/*
<MODULE_CONTRACT>
<purpose>Mission module index — re-export createForgeMissionModule for the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement mission logic here — the module registration lives in mission.module.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
</CHANGE_SUMMARY>
*/

export { createForgeMissionModule } from "./mission.module.ts";
