/*
<MODULE_CONTRACT>
<purpose>Barrel export for the ADR domain — types, constants, module, and handlers.</purpose>
<non-goals>
  <item>Do not implement ADR logic here; delegate to handlers/ and adr.module.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0366: expose adrModule and ADR types from the ADR domain.</item>
  <item>RFC-0521: migrated from packages/os/site-kernel/src/adr/ to packages/forge/os/adr/.</item>
</CHANGE_SUMMARY>
*/

export { forgeAdrModule } from "./adr.module.ts";
export { runAdrList, runAdrCreate } from "./handlers/list-create.ts";
export { runAdrValidate } from "./handlers/validate.ts";
export { runAdrArchive } from "./handlers/archive.ts";
export type {
  AdrArchiveResult,
  ArchiveMove as AdrArchiveMove,
  ArchiveSkip as AdrArchiveSkip,
} from "./handlers/archive.ts";
export type {
  AdrStatus,
  AdrScope,
  AdrFrontmatter,
  AdrListEntry,
  AdrListResult,
  AdrCreateResult,
  AdrValidationViolation,
  AdrValidationResult,
} from "./types.ts";
export { ADR_STATUSES, ADR_SCOPES, ADR_DIR, ADR_TEMPLATE_FILE, ADR_ID_PATTERN } from "./types.ts";
