/*
<MODULE_CONTRACT>
<purpose>Barrel for forgeGateModule — re-exports the gate module registration and the gate-probe/gate-probe-catalog handler entry points.</purpose>
<non-goals>
  <item>Command declarations and fixture IO — those live in gate.module.ts and the handlers; this file only re-exports.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-tail</item>
</CHANGE_SUMMARY>
*/

export { forgeGateModule } from "./gate.module.ts";
export { runGateProbe } from "./handlers/gate-probe.ts";
export { runGateProbeCatalog } from "./handlers/gate-probe-catalog.ts";
