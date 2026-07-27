/*
<MODULE_CONTRACT>
<purpose>Expose the forge Compass kernel module through a stable package subpath.</purpose>
<non-goals>
  <item>Do not implement compass handler logic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial compass module barrel.</item>
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
export {
  runCompassChangeSummaryValidate,
  runCompassSummaryTrim,
  classifyChangeSummaryItem,
  type ChangeSummaryItemClass,
} from "./handlers/compass-change-summary-handler.ts";
