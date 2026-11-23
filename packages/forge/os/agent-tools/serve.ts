/*
<MODULE_CONTRACT>
<purpose>
  RFC-1591 — `forge agent-tools serve` stdio entrypoint. Loads
  docs/agent-tools.generated.json, regenerates in memory when its
  manifestHash is stale (one warning; the file stays for
  command.tools.generate --check to heal), then wires the three meta tools
  and the front set onto an MCP Server. The SDK is a lazy dynamic import —
  the CLI dispatch path never pays for it outside serve.
</purpose>
<non-goals>
  <item>No tool logic — server.ts owns dispatch; this file owns the wire.</item>
  <item>No filesystem writes — a stale generated file regenerates in memory only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";

import { resolveIo } from "../../src/utils/io.ts";
import { loadAgentToolsConfig, loadCommandManifest } from "./manifest.ts";
import { buildAgentToolsFile } from "./generate.ts";
import { callTool, createDefaultRunner, listTools, type AgentToolsRuntime } from "./server.ts";
import { AGENT_TOOLS_FILE_RELATIVE, type AgentToolsFile } from "./types.ts";

export interface ServeOptions {
  workspaceRoot: string;
  io?: WorkspaceIO;
  runner?: AgentToolsRuntime["runner"];
  logger?: { warn: (msg: string) => void; error: (msg: string) => void };
}

/** Load the generated file; on manifestHash drift regenerate in memory and warn once. */
export async function loadAgentToolsFile(opts: ServeOptions): Promise<AgentToolsFile | undefined> {
  const io = resolveIo(opts.io);
  const filePath = join(opts.workspaceRoot, AGENT_TOOLS_FILE_RELATIVE);
  let file: AgentToolsFile | undefined;
  try {
    file = JSON.parse(await io.readFile(filePath)) as AgentToolsFile;
  } catch {
    file = undefined;
  }
  const manifest = await loadCommandManifest(opts.workspaceRoot, io);
  if (manifest === undefined) {
    opts.logger?.warn(`[agent-tools] ${COMMAND_MANIFEST_HINT} — serving the generated file as-is`);
    return file;
  }
  if (file !== undefined && file.manifestHash === manifest.hash) {
    return file;
  }
  const config = loadAgentToolsConfig(opts.workspaceRoot);
  const built = buildAgentToolsFile(manifest, config);
  if (built.file === undefined) {
    opts.logger?.warn(
      `[agent-tools] rebuild failed: ${built.issues.map((i) => i.message).join("; ")}`,
    );
    return file;
  }
  if (file !== undefined) {
    opts.logger?.warn(
      "[agent-tools] docs/agent-tools.generated.json is stale — regenerated in memory; " +
        "run `pnpm exec werkstatt run command.tools.generate` to heal the file",
    );
  }
  return built.file;
}

const COMMAND_MANIFEST_HINT = "docs/command-manifest.generated.yaml unavailable";

/**
 * Serve the stdio MCP session. Resolves the generated file (or regenerates
 * it), builds the runtime, and wires request handlers. Returns after
 * `server.connect` resolves — the caller keeps the process alive.
 */
export async function serveAgentTools(opts: ServeOptions): Promise<void> {
  const logger = opts.logger ?? console;
  const file = await loadAgentToolsFile(opts);
  if (file === undefined) {
    logger.error(
      `[agent-tools] ${AGENT_TOOLS_FILE_RELATIVE} missing and no command manifest to rebuild from — ` +
        "run `pnpm exec werkstatt run command.tools.generate` first",
    );
    process.exitCode = 1;
    return;
  }

  const runtime: AgentToolsRuntime = {
    workspaceRoot: opts.workspaceRoot,
    tools: file,
    runner: opts.runner ?? createDefaultRunner(),
  };

  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");

  const server = new Server(
    { name: "forge-tools", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(runtime),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const outcome = await callTool(runtime, request.params.name, args);
    const payload = outcome.ok
      ? outcome.result
      : {
          error: outcome.error,
          ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      isError: outcome.ok !== true,
    };
  });

  await server.connect(new StdioServerTransport());
}
