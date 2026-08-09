/*
<MODULE_CONTRACT>
<purpose>Barrel export for the exploration domain — types, constants, module, and handlers.</purpose>
<non-goals>
  <item>Do not implement exploration logic here; delegate to handlers/ and exploration.module.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0710: expose forgeExplorationModule and exploration types from the exploration domain.</item>
</CHANGE_SUMMARY>
*/

export { forgeExplorationModule } from "./exploration.module.ts";
export { runExplorationList } from "./handlers/list.ts";
export { runExplorationShow } from "./handlers/show.ts";
export { runExplorationArchive } from "./handlers/archive.ts";
export type {
  ExplorationStatus,
  ExplorationNote,
  ExplorationListEntry,
  ExplorationListResult,
  ExplorationShowResult,
  ExplorationArchiveResult,
} from "./types.ts";
export { EXPLORATION_STATUSES, EXPLORATION_DIR, EXPLORATION_SLUG_PATTERN } from "./types.ts";
