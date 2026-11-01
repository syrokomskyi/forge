/*
<MODULE_CONTRACT>
<purpose>Barrel for forgeTrajectoryModule — re-exports the trajectory module registration and the index/recall/outcome-record handler entry points.</purpose>
<non-goals>
  <item>Command declarations and journal IO — those live in trajectory.module.ts and the handlers; this file only re-exports.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-trajectory</item>
</CHANGE_SUMMARY>
*/

export { forgeTrajectoryModule } from "./trajectory.module.ts";
export { runTrajectoryIndex } from "./handlers/trajectory-index.ts";
export { runTrajectoryRecall } from "./handlers/trajectory-recall.ts";
export { runOutcomeRecord } from "./handlers/outcome-record.ts";
