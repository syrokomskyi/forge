/*
<MODULE_CONTRACT>
<purpose>Barrel for forgeChecksModule — re-exports the checks module registration plus the contribution-report, counters-export/validate, and counters-journal surfaces.</purpose>
<non-goals>
  <item>Command declarations and journal IO — those live in checks.module.ts and the handlers; this file only re-exports.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-checks</item>
</CHANGE_SUMMARY>
*/

export { forgeChecksModule } from "./checks.module.ts";
export { runContributionReport } from "./handlers/contribution-report.ts";
export { runCountersExport, type CountersExportData, type CounterRuleTotal } from "./handlers/counters-export.ts";
export { runCountersValidate, type CountersValidateData } from "./handlers/counters-validate.ts";
export {
  COUNTERS_JOURNAL_PATH,
  CHECK_COUNTER_OUTCOMES,
  checkCounterRecordSchema,
  computeRunOutcomes,
  readCountersJournal,
  recordRuleEvaluations,
  type CheckCounterOutcome,
  type CheckCounterRecord,
  type CountersJournalRead,
} from "./handlers/counters-journal.ts";
