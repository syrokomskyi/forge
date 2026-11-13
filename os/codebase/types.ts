/*
<MODULE_CONTRACT>
<purpose>
RFC-1581: contracts for codebase.measure — project-scale measurement over
git-tracked files. Categories, per-language measures, top-directory ranking.
</purpose>
<non-goals>
  <item>Does not define symbol contracts — symbol counts nest under LanguageMeasure.symbols.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1581: initial codebase.measure contracts.</item>
  <item>RFC-1581: apply REVIEW-CODE-2026-11-13-01 — contract alignment, repo-root anchor, publishConfig exports</item>
</CHANGE_SUMMARY>
*/

export type CodebaseCategory = "code" | "tests" | "docs" | "generated";

export interface CodebaseCategoryTotals {
  files: number;
  code: number;
}

export interface SymbolMeasure {
  classes: number;
  functions: number;
  methods: number;
}

export interface LanguageMeasure {
  language: string;
  files: number;
  code: number;
  comments: number;
  blanks: number;
  symbols?: SymbolMeasure;
}

export interface TopDirMeasure {
  path: string;
  code: number;
}

export interface CodebaseMeasure {
  command: "codebase.measure";
  status: "ok";
  repo: string;
  totals: Record<CodebaseCategory, CodebaseCategoryTotals>;
  languages: LanguageMeasure[];
  topDirs: TopDirMeasure[];
  symbolsSkipped: string[];
  binaryFiles: number;
  exclusions: string[];
  measuredAt: string;
}
