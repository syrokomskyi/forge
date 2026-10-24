/*
<MODULE_CONTRACT>
<purpose>Barrel export for the forge formal module — re-exports the module
factory and the proof.check handler entry point (RFC-1391).</purpose>
<non-goals>
  <item>Do not add logic here — re-exports only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391: barrel export for os/formal.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
</CHANGE_SUMMARY>
*/

export { createForgeFormalModule } from "./formal.module.ts";
export { runProofCheckCommand } from "./handlers/proof-check.ts";
export type { ProofCheckCommandResult } from "./handlers/proof-check.ts";
