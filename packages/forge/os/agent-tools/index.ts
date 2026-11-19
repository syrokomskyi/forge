/*
<MODULE_CONTRACT>
<purpose>Public barrel for the agent-tools module — re-exports the module factory, agent tools file builders, server helpers, and shared types.</purpose>
<non-goals>
  <item>Do not implement module logic — this file only re-exports the agent-tools surface.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

export { createForgeAgentToolsModule } from "./agent-tools.module.ts";
export type {
  AgentToolDefinition,
  AgentToolsFile,
  AgentToolInputSchema,
  AgentToolCommandSpec,
  ManifestCommandEntry,
} from "./types.ts";
export { AGENT_TOOLS_FILE_RELATIVE, AGENT_TOOLS_SCHEMA, AGENT_TOOLS_FRONT_LIMIT } from "./types.ts";
export { buildAgentToolsFile, serializeAgentToolsFile } from "./generate.ts";
export { loadAgentToolsFile, serveAgentTools } from "./serve.ts";
export { callTool, listTools, createDefaultRunner } from "./server.ts";
