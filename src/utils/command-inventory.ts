/*
<MODULE_CONTRACT>
<purpose>Live command inventory — union of the runtime commandRegistry and
docs/command-manifest.generated.yaml (the getLiveCommands precedent from
os/rfc/handlers/lifecycle.ts, widened to full reads/writes/flags entries for
RFC-1528's owner-discovery and resolvability consumers). Required because
werkstatt run injects no commandRegistry and lazy-loaded modules are invisible
to it — a registry-only read silently disables any consumer on the primary
dispatch path (RFC-1518 r1, deviation D-001).</purpose>
<non-goals>
  <item>No kernel or engine imports — portable src-layer helper.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1528: initial — loadManifestCommandEntries + loadLiveCommandInventory (review F-1 fix).</item>
  <item>RFC-1528: close review findings — manifest-union command inventory for regen/preflight</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CommandRegistry, ForgeRegisteredCommandInfo } from "../types.ts";

export interface ManifestCommandEntry {
  name: string;
  module?: string;
  siteScope?: boolean;
  reads?: string[];
  writes?: string[];
  generates?: Array<{
    path: string;
    phase?: string;
    conditional?: boolean;
    markerPolicy?: string;
    volatile?: boolean;
  }>;
  flags?: Record<string, unknown>;
}

const MANIFEST_RELATIVE_PATH = join("docs", "command-manifest.generated.yaml");

/**
 * Parse the generated command manifest into registered-command-shaped
 * entries. Absent or unparsable manifest → empty list (registry still wins).
 */
export function loadManifestCommandEntries(workspaceRoot: string): ForgeRegisteredCommandInfo[] {
  try {
    const raw = readFileSync(join(workspaceRoot, MANIFEST_RELATIVE_PATH), "utf8");
    const parsed = parseYaml(raw) as { commands?: ManifestCommandEntry[] } | null;
    const entries: ForgeRegisteredCommandInfo[] = [];
    for (const c of parsed?.commands ?? []) {
      if (typeof c?.name !== "string" || c.name.length === 0) continue;
      entries.push({
        name: c.name,
        provider: "workspace",
        description: "",
        scope: "workspace",
        ...(c.module !== undefined ? { module: c.module } : {}),
        ...(c.reads !== undefined ? { reads: c.reads } : {}),
        ...(c.writes !== undefined ? { writes: c.writes } : {}),
        ...(c.generates !== undefined
          ? {
              generates: c.generates.map((g) => ({
                path: g.path,
                phase: (g.phase ?? "on-demand") as "on-demand",
              })),
            }
          : {}),
        flags: (c.flags ?? {}) as ForgeRegisteredCommandInfo["flags"],
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Union runtime registry with the generated manifest — the D-001 merge.
 * Registry entries win on collision; manifest entries cover commands whose
 * modules are not loaded in the current dispatch.
 */
export function loadLiveCommandInventory(
  workspaceRoot: string,
  commandRegistry?: CommandRegistry,
): ForgeRegisteredCommandInfo[] {
  const byName = new Map<string, ForgeRegisteredCommandInfo>();
  for (const entry of loadManifestCommandEntries(workspaceRoot)) {
    byName.set(entry.name, entry);
  }
  for (const entry of commandRegistry?.listCommands() ?? []) {
    const prev = byName.get(entry.name);
    byName.set(entry.name, {
      ...prev,
      ...entry,
      module: entry.module ?? prev?.module,
      reads: entry.reads ?? prev?.reads,
      writes: entry.writes ?? prev?.writes,
      generates: entry.generates ?? prev?.generates,
      flags: entry.flags ?? prev?.flags,
    });
  }
  return [...byName.values()];
}
