/*
<MODULE_CONTRACT>
<purpose>Barrel export for the plan domain — types, module, and handlers.</purpose>
<non-goals>
  <item>Do not implement plan logic here; delegate to handlers/ and plan.module.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: initial plan module barrel.</item>
</CHANGE_SUMMARY>
*/

export { forgePlanModule } from "./plan.module.ts";
export { runPlanArchive } from "./handlers/archive.ts";
export {
  listPlanFiles,
  parsePlanFile,
  readAndParsePlan,
  extractRfcIdFromPlanFile,
  type ParsedPlan,
} from "./frontmatter-io.ts";
export type { PlanArchiveResult, PlanArchiveMove, PlanArchiveSkip } from "./types.ts";
export { PLAN_DIR, PLAN_FILE_PATTERN } from "./types.ts";
