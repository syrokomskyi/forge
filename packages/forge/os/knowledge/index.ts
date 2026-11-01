/*
<MODULE_CONTRACT>
<purpose>os/knowledge index barrel — re-exports the forgeKnowledgeModule and the public knowledge command handlers.</purpose>
<non-goals>
  <item>No logic lives here — implementations stay in ./knowledge.module.ts and ./handlers/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1481: re-export runKnowledgeConflictsResolve for explicit knowledge collision remediation.</item>
  <history>RFC-1468</history>
</CHANGE_SUMMARY>
*/

export { forgeKnowledgeModule } from "./knowledge.module.ts";
export { runKnowledgeRebuild } from "./handlers/knowledge-rebuild.ts";
export { runKnowledgeAuthzProbe } from "./handlers/knowledge-authz-probe.ts";
export { runKnowledgeConflictsResolve } from "./handlers/knowledge-conflicts-resolve.ts";
