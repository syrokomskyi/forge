/*
<MODULE_CONTRACT>
<purpose>
Type definitions for the audit archive domain — audit file discovery, parsing,
and archive result shapes.
</purpose>
<non-goals>
  <item>Do not define archive handler logic here — that lives in handlers/archive.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: initial audit archive types.</item>
</CHANGE_SUMMARY>
*/

import type { ArchiveMove, ArchiveSkip } from "../rfc/handlers/archive.ts";

export const AUDIT_DIR = "docs/audits";
export const AUDIT_RFC_FILE_PATTERN = /^audit-rfc-\d{4}-/;

export interface AuditArchiveResult {
  command: "audit.archive";
  status: "ok";
  moved: ArchiveMove[];
  skipped: ArchiveSkip[];
  dryRun: boolean;
}

export type { ArchiveMove as AuditArchiveMove, ArchiveSkip as AuditArchiveSkip };
