/*
<MODULE_CONTRACT>
<purpose>
  RFC-1591 — typed agent-tool contracts. One kernel command becomes one MCP
  tool definition: the manifest flag schema maps to a JSON Schema input so a
  tool call with an unknown argument is rejected by the client before
  anything runs. The generated file (docs/agent-tools.generated.json) is the
  server's single input — front-set typed tools plus the three meta tools
  (command_search / command_describe / command_run) cover the whole surface.
</purpose>
<non-goals>
  <item>No MCP SDK types here — serve.ts owns the wire shape; this file stays dependency-free.</item>
  <item>No Studio Gate surface — the developer server is a separate registration (DNA-56).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

export const AGENT_TOOLS_SCHEMA = "forge/agent-tools@1";
export const AGENT_TOOLS_FILE_RELATIVE = "docs/agent-tools.generated.json";
export const AGENT_TOOLS_GENERATOR = "command.tools.generate";

/** Hard cap on agentTools.front — a larger flat list floods the agent's tool budget. */
export const AGENT_TOOLS_FRONT_LIMIT = 40;

export interface AgentToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
}

export interface AgentToolAnnotations {
  /** true when the manifest declares mutatesState: false. */
  readOnlyHint: boolean;
  /** true when the manifest declares mutatesState: true — a mutating call warrants client confirmation. */
  destructiveHint: boolean;
}

export interface AgentToolDefinition {
  /** MCP tool name — the command name with `.` and `-` replaced by `_`. */
  name: string;
  /** Kernel command name as registered in the manifest. */
  command: string;
  description: string;
  inputSchema: AgentToolInputSchema;
  annotations: AgentToolAnnotations;
}

/**
 * Stored per-command entry — the tool contract plus the manifest `detachable`
 * flag so command_run knows to spawn with --detach and return the run id.
 */
export type AgentToolCommandSpec = Omit<AgentToolDefinition, "name"> & {
  detachable?: boolean;
};

export interface AgentToolsFile {
  schema: typeof AGENT_TOOLS_SCHEMA;
  generatedBy: typeof AGENT_TOOLS_GENERATOR;
  /** Manifest content hash the file was generated from — drift means stale. */
  manifestHash: string;
  /** Deny-listed command names — absent from `commands` and refused by command_run (AGENT-TOOL-02). */
  deny: string[];
  /** agentTools.front projected one tool each (manifest order). */
  front: AgentToolDefinition[];
  /** Every non-denied manifest command, keyed by command name. */
  commands: Record<string, AgentToolCommandSpec>;
}

/** Manifest flag spec fields the tool surface consumes. */
export interface ManifestFlagSpec {
  kind: "boolean" | "string" | "string[]";
  required?: boolean;
  enum?: string[];
  description?: string;
}

/** One command entry as read from docs/command-manifest.generated.yaml. */
export interface ManifestCommandEntry {
  name: string;
  description?: string;
  mutatesState?: boolean;
  detachable?: boolean;
  flagsOpen?: boolean;
  flags?: Record<string, ManifestFlagSpec>;
}

/** MCP tool name — `ecosystem.commit` → `ecosystem_commit`, `mission.git.commit` → `mission_git_commit`. */
export function toolNameFor(command: string): string {
  return command.replace(/[.-]/g, "_");
}

/** JSON Schema for one manifest flag spec (RFC-1591 flag mapping). */
export function flagToJsonSchema(spec: ManifestFlagSpec): Record<string, unknown> {
  const base: Record<string, unknown> =
    spec.kind === "boolean"
      ? { type: "boolean" }
      : spec.kind === "string[]"
        ? { type: "array", items: { type: "string" } }
        : { type: "string" };
  if (spec.kind !== "boolean" && spec.enum !== undefined && spec.enum.length > 0) {
    if (spec.kind === "string") base["enum"] = [...spec.enum];
    else base["items"] = { type: "string", enum: [...spec.enum] };
  }
  if (spec.description !== undefined && spec.description !== "") {
    base["description"] = spec.description;
  }
  return base;
}

/**
 * Project one manifest command into its tool contract. `flagsOpen` commands
 * keep `additionalProperties: true` — the documented schema cannot enumerate
 * their passthrough surface.
 */
export function commandToToolSpec(entry: ManifestCommandEntry): Omit<AgentToolDefinition, "name"> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [flag, spec] of Object.entries(entry.flags ?? {})) {
    properties[flag] = flagToJsonSchema(spec);
    if (spec.required === true) required.push(flag);
  }
  return {
    command: entry.name,
    description: entry.description ?? "",
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: entry.flagsOpen === true,
    },
    annotations: {
      readOnlyHint: entry.mutatesState === false,
      destructiveHint: entry.mutatesState === true,
    },
  };
}
