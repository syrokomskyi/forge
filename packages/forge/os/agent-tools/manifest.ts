/*
<MODULE_CONTRACT>
<purpose>
  RFC-1591 — load the two inputs the tool surface is generated from:
  docs/command-manifest.generated.yaml (the command schema) and forge.yaml's
  agentTools section (front set + deny list). The manifest hash is its
  meta.contentHash when present, else a sha256 of the raw bytes — the
  generated file pins whichever form it read, so --check and server-start
  drift detection compare like with like.
</purpose>
<non-goals>
  <item>No write paths — generation lives in generate.ts.</item>
  <item>No kernel/engine imports — the manifest is parsed from disk, never from a live registry (autonomous module).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

import { createHash } from "node:crypto";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { WorkspaceIO } from "@warpgogol/werkstatt-shared/kernel";

import { loadForgeConfig } from "../../src/config/forge-config.ts";
import { resolveIo } from "../../src/utils/io.ts";
import type { ManifestCommandEntry } from "./types.ts";

export const COMMAND_MANIFEST_RELATIVE = "docs/command-manifest.generated.yaml";

export interface CommandManifestData {
  /** meta.contentHash when the manifest carries it, else sha256 of the raw bytes. */
  hash: string;
  commands: ManifestCommandEntry[];
}

export interface AgentToolsConfig {
  front: string[];
  deny: string[];
}

interface RawManifest {
  meta?: { contentHash?: string | null };
  commands?: ManifestCommandEntry[];
}

/**
 * Read and parse the command manifest. Returns undefined when the file is
 * absent or unparsable — callers surface their own diagnostic rather than
 * conflating "no workshop" with "empty surface".
 */
export async function loadCommandManifest(
  workspaceRoot: string,
  io?: WorkspaceIO,
): Promise<CommandManifestData | undefined> {
  const resolvedIo = resolveIo(io);
  const manifestPath = join(workspaceRoot, COMMAND_MANIFEST_RELATIVE);
  let raw: string;
  try {
    raw = await resolvedIo.readFile(manifestPath);
  } catch {
    return undefined;
  }
  let parsed: RawManifest;
  try {
    parsed = parseYaml(raw) as RawManifest;
  } catch {
    return undefined;
  }
  const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
  const hash =
    typeof parsed.meta?.contentHash === "string" && parsed.meta.contentHash.length > 0
      ? parsed.meta.contentHash
      : createHash("sha256").update(raw).digest("hex");
  return { hash, commands };
}

/**
 * forge.yaml `agentTools:` — absent section or absent forge.yaml both mean
 * an empty front set and no deny entries. loadForgeConfig throws on a
 * missing file; the agent-tools surface treats that as "no config" rather
 * than a refusal so the generator stays usable in a bare checkout.
 */
export function loadAgentToolsConfig(workspaceRoot: string): AgentToolsConfig {
  try {
    const config = loadForgeConfig(workspaceRoot);
    const front = Array.isArray(config.agentTools?.front) ? config.agentTools.front : [];
    const deny = Array.isArray(config.agentTools?.deny) ? config.agentTools.deny : [];
    return { front: [...front], deny: [...deny] };
  } catch {
    return { front: [], deny: [] };
  }
}
