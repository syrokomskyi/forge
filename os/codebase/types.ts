/*
<MODULE_CONTRACT>
<purpose>
RFC-1581: contracts for codebase.measure — project-scale measurement over
git-tracked files. Categories, per-language measures, top-directory ranking.
</purpose>
<non-goals>
  <item>Does not define symbol contracts — symbol counts fold into LanguageMeasure.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1581: initial codebase.measure contracts.</item>
  <item>RFC-1581: add codebase.measure project-scale measurement command</item>
</CHANGE_SUMMARY>
*/

export type CodebaseCategory = "code" | "tests" | "docs" | "generated";

export interface CodebaseCategoryTotals {
  files: number;
  code: number;
}

export interface LanguageMeasure {
  language: string;
  files: number;
  code: number;
  comments: number;
  blanks: number;
  classes: number;
  functions: number;
  methods: number;
}

export interface TopDirMeasure {
  dir: string;
  code: number;
}

export interface CodebaseMeasure {
  command: "codebase.measure";
  status: "ok";
  totals: Record<CodebaseCategory, CodebaseCategoryTotals>;
  languages: LanguageMeasure[];
  topDirs: TopDirMeasure[];
  binaryFiles: number;
  symbolsSkipped: string[];
}
