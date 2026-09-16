/* 
<MODULE_CONTRACT> 
<purpose>Facilitates the export of workflow-related modules and types for use in the application.</purpose> 
 
 
<non-goals> 
  <item>Do not implement workflow execution logic.</item> 
  <item>Do not handle raw content parsing or transformation.</item> 
</non-goals> 
</MODULE_CONTRACT> 
 
<CHANGE_SUMMARY>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into <history>, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
</CHANGE_SUMMARY> 
*/

export { createForgeWorkflowModule } from "./workflow.module.ts";
export { runWorkflowLint, runWorkflowList, runWorkflowAmendList } from "./handlers.ts";
export type {
  WorkflowPhase,
  WorkflowChain,
  WorkflowPreconditions,
  WorkflowBranch,
  WorkflowFrontmatter,
  WorkflowListEntry,
  WorkflowLintViolation,
  WorkflowLintResult,
} from "./types.ts";
