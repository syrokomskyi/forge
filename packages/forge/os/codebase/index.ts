/*
<MODULE_CONTRACT>
<purpose>Public barrel for the forge-codebase module — re-exports the codebase module factory, the codebase.measure handler, and shared measurement types.</purpose>
<non-goals>
  <item>Do not implement measurement logic — this file only re-exports the codebase surface.</item>
</non-goals>
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
