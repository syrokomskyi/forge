/*
<MODULE_CONTRACT>
<purpose>Barrel export for the session domain — types, module, and handlers.</purpose>
<non-goals>
  <item>Do not implement session logic here; delegate to handlers/ and session.module.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: initial session module barrel.</item>
</CHANGE_SUMMARY>
*/

export { forgeSessionModule } from "./session.module.ts";
export { runSessionSave } from "./handlers/save.ts";
export { runSessionArchive } from "./handlers/archive.ts";
export { runSessionValidate } from "./handlers/validate.ts";
export { runSessionList } from "./handlers/list.ts";
export {
  parseSessionFile,
  listSessionFiles,
  listArchivedSessionFiles,
  readAndParseSession,
  listNonMarkdownSessionFiles,
  listRawFiles,
  type ParsedSession,
} from "./frontmatter-io.ts";
export {
  parseAtif,
  messagesToTranscriptMarkdown,
  type AtifMessage,
  type AtifParseResult,
} from "./atif-parser.ts";
export {
  SESSION_DIR,
  SESSION_RAW_SUBDIR,
  SESSION_ARCHIVE_SUBDIR,
  SESSION_TYPES,
  SES_RULES,
  type SessionType,
  type SessionFrontmatter,
  type SessionSaveResult,
  type SessionArchiveResult,
  type SessionArchiveMove,
  type SessionArchiveSkip,
  type SessionValidationResult,
  type SessionValidationViolation,
  type SessionListResult,
  type SessionListEntry,
  type SesRule,
} from "./types.ts";
