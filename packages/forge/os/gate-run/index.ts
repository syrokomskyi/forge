/*
<MODULE_CONTRACT>
<purpose>Public barrel for the gate-run module — re-exports the module factory, gate run record helpers, and the detach machinery.</purpose>
<non-goals>
  <item>Do not implement run logic — this file only re-exports the gate-run surface.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

export { createForgeGateRunModule } from "./gate-run.module.ts";
export {
  GATE_RUN_RETENTION,
  GATE_RUNS_DIR,
  classifyGateRun,
  finishGateRun,
  gateRunsDir,
  listGateRuns,
  repoRelativeCwd,
  saveGateRun,
  startGateRun,
} from "./record.ts";
export { GATE_RUN_ID_ENV, HEARTBEAT_WAIT_MS, detachPointerLines, detachSelf } from "./detach.ts";
export type { DetachResult } from "./detach.ts";
export { GATE_RUN_RULES, GATE_RUN_SCHEMA } from "./types.ts";
export type { GateRunRecord, GateRunStatus, SpawnLike, SpawnLikeChild } from "./types.ts";
