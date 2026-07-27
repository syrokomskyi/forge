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
] as const;
