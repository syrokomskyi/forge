/*
<MODULE_CONTRACT>
<purpose>Migration-adapter registry — built-in adapters + config-discovered external adapters (RFC-0546).</purpose>
<non-goals>
  <item>Do not import from @gogol/* — this module is portable.</item>
  <item>Do not apply migration here — selection only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0546: initial migration-adapter registry with built-in adapters.</item>
</CHANGE_SUMMARY>
*/

import type { MigrationAdapter } from "./types.ts";
import { nodeTypescriptPnpmAdapter } from "./node-typescript-pnpm/index.ts";
import { phaserPnpmAdapter } from "./phaser-pnpm/index.ts";
import type { ForgeConfig } from "../config/forge-config.ts";

const BUILT_IN_ADAPTERS: MigrationAdapter[] = [
  nodeTypescriptPnpmAdapter,
  phaserPnpmAdapter,
];

export function getAdapters(config?: ForgeConfig): MigrationAdapter[] {
  const adapters = [...BUILT_IN_ADAPTERS];

  const configAdapters = config?.migrationAdapters ?? [];
  for (const entry of configAdapters) {
    if (entry.module) {
      // External adapter — would require dynamic import at runtime.
      // The skill handles dynamic import; registry returns built-ins only for now.
      // External adapters with module field are resolved by the skill at runtime.
      continue;
    }
    // Built-in adapter referenced by id only — already in BUILT_IN_ADAPTERS
  }

  return adapters;
}

export function detectAdapter(sourceDir: string, config?: ForgeConfig): MigrationAdapter | null {
  const adapters = getAdapters(config);
  const matches = adapters.filter((a) => {
    try {
      return a.detect(sourceDir);
    } catch {
      return false;
    }
  });

  if (matches.length === 0) return null;
  return matches[0];
}

export function detectAdapters(sourceDir: string, config?: ForgeConfig): MigrationAdapter[] {
  const adapters = getAdapters(config);
  return adapters.filter((a) => {
    try {
      return a.detect(sourceDir);
    } catch {
      return false;
    }
  });
}
