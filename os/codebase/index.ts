/*
<MODULE_CONTRACT>
<purpose>RFC-1581: barrel for the forge-codebase module.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1581: initial barrel.</item>
  <item>RFC-1581: add codebase.measure project-scale measurement command</item>
  <item>RFC-1581: apply REVIEW-CODE-2026-11-13-01 — contract alignment, repo-root anchor, publishConfig exports</item>
</CHANGE_SUMMARY>
*/

export { createForgeCodebaseModule } from "./codebase.module.ts";
export { runCodebaseMeasure } from "./handlers/codebase-measure.ts";
export type {
  CodebaseCategory,
  CodebaseCategoryTotals,
  CodebaseMeasure,
  LanguageMeasure,
  SymbolMeasure,
  TopDirMeasure,
} from "./types.ts";
