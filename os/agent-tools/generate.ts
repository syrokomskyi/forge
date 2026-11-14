/*
<MODULE_CONTRACT>
<purpose>
  RFC-1591 — build the agent-tools document from a parsed command manifest
  and the forge.yaml agentTools section. Deny-listed commands never enter
  `commands` (command_search and command_describe cannot surface them);
  agentTools.front entries are validated against the manifest — an unknown
  name refuses AGENT-TOOL-04, more than 40 refuses AGENT-TOOL-03. The
  document is serialized deterministically (sorted command keys, stable
  field order) so --check can byte-compare.
</purpose>
<non-goals>
  <item>No filesystem IO — the handler owns reads/writes.</item>
  <item>No suggestion/search logic — server.ts owns the runtime surface.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import {
  AGENT_TOOLS_FRONT_LIMIT,
  AGENT_TOOLS_GENERATOR,
  AGENT_TOOLS_SCHEMA,
  commandToToolSpec,
  toolNameFor,
  type AgentToolDefinition,
  type AgentToolsFile,
} from "./types.ts";
import type { AgentToolsConfig, CommandManifestData } from "./manifest.ts";

export interface AgentToolsBuildIssue {
  ruleId: "AGENT-TOOL-03" | "AGENT-TOOL-04";
  message: string;
}

export interface AgentToolsBuildResult {
  file?: AgentToolsFile;
  issues: AgentToolsBuildIssue[];
}

/**
 * Build the generated-file object. `config.front` names manifest command
 * names (not underscored tool names); duplicates collapse to first mention.
 */
export function buildAgentToolsFile(
  manifest: CommandManifestData,
  config: AgentToolsConfig,
): AgentToolsBuildResult {
  const issues: AgentToolsBuildIssue[] = [];
  const deny = new Set(config.deny);
  const byName = new Map(manifest.commands.map((c) => [c.name, c]));

  const commands: AgentToolsFile["commands"] = {};
  for (const entry of [...manifest.commands].sort((a, b) => a.name.localeCompare(b.name))) {
    if (deny.has(entry.name)) continue;
    commands[entry.name] = {
      ...commandToToolSpec(entry),
      ...(entry.detachable === true ? { detachable: true } : {}),
    };
  }

  const front: AgentToolDefinition[] = [];
  const seenFront = new Set<string>();
  for (const name of config.front) {
    if (seenFront.has(name) || deny.has(name)) continue;
    seenFront.add(name);
    const entry = byName.get(name);
    if (entry === undefined) {
      issues.push({
        ruleId: "AGENT-TOOL-04",
        message: `agentTools.front names "${name}", which is absent from docs/command-manifest.generated.yaml — fix the name or remove the entry`,
      });
      continue;
    }
    front.push({ name: toolNameFor(name), ...commandToToolSpec(entry) });
  }
  if (config.front.length > AGENT_TOOLS_FRONT_LIMIT) {
    issues.push({
      ruleId: "AGENT-TOOL-03",
      message: `agentTools.front declares ${config.front.length} entries — the cap is ${AGENT_TOOLS_FRONT_LIMIT}; move the rest behind command_search/command_run`,
    });
  }

  if (issues.length > 0) {
    return { issues };
  }
  return {
    file: {
      schema: AGENT_TOOLS_SCHEMA,
      generatedBy: AGENT_TOOLS_GENERATOR,
      manifestHash: manifest.hash,
      deny: [...config.deny],
      front,
      commands,
    },
    issues,
  };
}

/** Deterministic serialization — trailing newline, 2-space indent. */
export function serializeAgentToolsFile(file: AgentToolsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
