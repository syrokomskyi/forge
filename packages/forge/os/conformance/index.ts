/*
<MODULE_CONTRACT>
<purpose>Barrel export for the forge conformance module — re-exports the module
factory and handler entry points (RFC-1365).</purpose>
<non-goals>
  <item>Do not add logic here — re-exports only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1365: step 2 — barrel export for os/conformance.</item>
  <item>RFC-1365: step 2 — forge.conformance.run/validate commands + dual-surface registration</item>
</CHANGE_SUMMARY>
*/

export { createForgeConformanceModule } from "./conformance.module.ts";
export { runConformanceRun } from "./handlers/conformance-run.ts";
export { runConformanceValidate } from "./handlers/conformance-validate.ts";
export type { ConformanceRunResult } from "./handlers/conformance-run.ts";
export type { ConformanceValidateResult } from "./handlers/conformance-validate.ts";
