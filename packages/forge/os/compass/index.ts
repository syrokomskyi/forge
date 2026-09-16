/*
<MODULE_CONTRACT>
<purpose>Expose the forge Compass kernel module through a stable package subpath.</purpose>
<non-goals>
  <item>Do not implement compass handler logic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial compass module barrel.</item>
  <item>RFC-1095: compass.summary.record, trim repair rewrite, commit integration</item>
  <item>RFC-1095: review findings: execFileSync git add, drop speculative barrel exports</item>
  <item>RFC-1097: steps 1-4 — compass.migrate codemod

Add the v1 to v2 Compass header codemod: migrateFile pure transform (collapse, strip, seed, reorder, purpose-flag actions), migrateWorkspace walker, runCompassMigrate handler with dirty-tree refusal and --force/--files/--dry-run flags, module registration, and 15 unit tests.</item>
</CHANGE_SUMMARY>
*/

export { forgeCompassModule } from "./compass.module.ts";
export {
  createCompassInventoryEntries,
  type CompassInventoryEntry,
} from "./handlers/compass-inventory.ts";
export { resolveCompassScanRoot } from "./handlers/resolve-scan-root.ts";
export { getRevisionByPath, type RevisionByPathResult } from "./handlers/git-revision.ts";
export { runCompassInventory, runCompassValidation } from "./handlers/compass-inventory-handler.ts";
export {
  runCompassAuditPlan,
  runCompassAuditRecord,
  runCompassAuditBaseline,
  runCompassAuditValidate,
  isAuditDue,
} from "./handlers/compass-audit-handler.ts";
export { runCompassSummaryTrim } from "./handlers/compass-change-summary-handler.ts";
export { runCompassMigrate } from "./handlers/compass-migrate-handler.ts";
export {
  migrateFile,
  migrateWorkspace,
  type MigrateAction,
  type MigrateResult,
} from "./handlers/compass-migrate.ts";
export {
  runCompassSummaryRecord,
  parseChangeSummary,
  mergeHistoryIds,
  buildChangeSummaryBlock,
  stripConventionalPrefix,
  isValidGovernanceId,
  CHANGE_SUMMARY_WINDOW,
  type SummaryRecordResult,
  type SummaryRecordSkipReason,
} from "./handlers/summary-record.ts";
