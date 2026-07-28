/*
<MODULE_CONTRACT>
<purpose>Barrel export for migration-adapter module (RFC-0546).</purpose>
<non-goals>
  <item>Do not re-export implementation details — only public types and registry functions.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0546: initial barrel export for migration-adapters.</item>
</CHANGE_SUMMARY>
*/

export type { MigrationAdapter, AdapterAnalysis, MigrationResult, Conflict } from "./types.ts";

export { FORGE_PROTECTED_PATHS, DEFAULT_EXCLUDE_PATTERNS } from "./types.ts";

export { nodeTypescriptPnpmAdapter } from "./node-typescript-pnpm/index.ts";
export { phaserPnpmAdapter } from "./phaser-pnpm/index.ts";
export { getAdapters, detectAdapter, detectAdapters } from "./registry.ts";
export { discoverIgnoredFiles, formatSize } from "./ignored-files.ts";
export type { IgnoredFileCategory, IgnoredFileCategoryId } from "./ignored-files.ts";
