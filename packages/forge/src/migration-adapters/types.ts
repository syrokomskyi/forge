/*
<MODULE_CONTRACT>
<purpose>Migration-adapter type contracts — interfaces for stack-specific code migration into forge projects (RFC-0546).</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not implement adapter logic here — only type definitions.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0546: initial migration-adapter type contracts (MigrationAdapter, AdapterAnalysis, MigrationResult, Conflict).</item>
  <item>RFC-0547: remove .git from DEFAULT_EXCLUDE_PATTERNS — git history handled by postSetup via format-patch + git am.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into <history>, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
</CHANGE_SUMMARY>
*/

export interface MigrationAdapter {
  id: string;
  detect(sourceDir: string): boolean;
  analyze(sourceDir: string): AdapterAnalysis;
  migrate(sourceDir: string, targetDir: string, analysis: AdapterAnalysis): MigrationResult;
  postSetup(sourceDir: string, targetDir: string, analysis: AdapterAnalysis): void;
}

export interface AdapterAnalysis {
  stack: string[];
  packageManager: string;
  bindings: {
    typecheck: string | null;
    test: string | null;
    scopedBuild: string | null;
  };
  placement: "apps" | "packages";
  appName: string;
  excludePatterns: string[];
  gitHistory: boolean;
}

export interface MigrationResult {
  filesCopied: string[];
  filesSkipped: string[];
  conflicts: Conflict[];
  workspaceUpdated: boolean;
}

export interface Conflict {
  path: string;
  sourceExists: boolean;
  forgeExists: boolean;
  resolution: "forge-wins" | "source-wins";
}

export const FORGE_PROTECTED_PATHS = [
  "forge.yaml",
  ".agents",
  "docs/rfcs",
  "docs/adrs",
  "PREFERENCES.md",
] as const;

export const DEFAULT_EXCLUDE_PATTERNS = [
  "node_modules",
  "dist",
  ".next",
  ".cache",
  ".turbo",
  ".git",
] as const;
