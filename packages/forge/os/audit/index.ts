/*
<MODULE_CONTRACT>
<purpose>Barrel export for the audit domain — types, module, and handlers.</purpose>
<non-goals>
  <item>Do not implement audit logic here; delegate to handlers/ and audit.module.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: initial audit module barrel.</item>
</CHANGE_SUMMARY>
*/

export { forgeAuditModule } from "./audit.module.ts";
export { runAuditArchive } from "./handlers/archive.ts";
export {
  listAuditFiles,
  parseAuditFile,
  readAndParseAudit,
  extractRfcIdFromAuditFile,
  type ParsedAudit,
} from "./frontmatter-io.ts";
export type { AuditArchiveResult, AuditArchiveMove, AuditArchiveSkip } from "./types.ts";
export { AUDIT_DIR, AUDIT_RFC_FILE_PATTERN } from "./types.ts";
