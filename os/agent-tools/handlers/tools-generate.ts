/*
<MODULE_CONTRACT>
<purpose>
  RFC-1591 — command.tools.generate: project docs/command-manifest.generated.yaml
  plus forge.yaml's agentTools section into docs/agent-tools.generated.json
  (forge/agent-tools@1). The default run writes the file; --check regenerates
  in memory and fails on byte drift so the integrate preflight catches a
  stale projection. Refusals: AGENT-TOOL-03 (>40 front entries),
  AGENT-TOOL-04 (front name absent from the manifest).
</purpose>
<non-goals>
  <item>No server runtime — serve.ts owns the MCP surface.</item>
  <item>No hand-maintained schemas — a wrong flag spec is fixed on the command, not here.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { buildAgentToolsFile, serializeAgentToolsFile } from "../generate.ts";
import {
  COMMAND_MANIFEST_RELATIVE,
  loadAgentToolsConfig,
  loadCommandManifest,
} from "../manifest.ts";
import { AGENT_TOOLS_FILE_RELATIVE } from "../types.ts";

export interface ToolsGenerateData {
  path: string;
  commandCount: number;
  frontCount: number;
  denyCount: number;
  manifestHash: string;
  check?: boolean;
  drift?: boolean;
  issues?: Array<{ ruleId: string; message: string }>;
}

export async function runCommandToolsGenerate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ToolsGenerateData>> {
  const io = resolveIo(context.io);
  const check = input.flags["check"] === true;
  const manifest = await loadCommandManifest(context.workspaceRoot, io);
  if (manifest === undefined) {
    return {
      exitCode: 1,
      summary:
        `[command.tools.generate] FAIL ${COMMAND_MANIFEST_RELATIVE} is missing or unparsable — ` +
        "run `pnpm exec werkstatt run command.manifest.generate` first",
      nextSteps: [
        {
          kind: "required",
          action: "regenerate the command manifest, then re-run command.tools.generate",
        },
      ],
    };
  }

  const config = loadAgentToolsConfig(context.workspaceRoot);
  const built = buildAgentToolsFile(manifest, config);
  if (built.file === undefined) {
    return {
      exitCode: 1,
      summary: `[command.tools.generate] FAIL ${built.issues
        .map((i) => `${i.ruleId}: ${i.message}`)
        .join(" | ")}`,
      data: {
        path: AGENT_TOOLS_FILE_RELATIVE,
        commandCount: manifest.commands.length,
        frontCount: config.front.length,
        denyCount: config.deny.length,
        manifestHash: manifest.hash,
        issues: built.issues,
      },
      nextSteps: [
        {
          kind: "required",
          action: "fix the agentTools section in forge.yaml, then re-run",
        },
      ],
    };
  }

  const serialized = serializeAgentToolsFile(built.file);
  const filePath = join(context.workspaceRoot, AGENT_TOOLS_FILE_RELATIVE);
  const data: ToolsGenerateData = {
    path: AGENT_TOOLS_FILE_RELATIVE,
    commandCount: Object.keys(built.file.commands).length,
    frontCount: built.file.front.length,
    denyCount: built.file.deny.length,
    manifestHash: built.file.manifestHash,
  };

  if (check) {
    let existing: string | undefined;
    try {
      existing = await io.readFile(filePath);
    } catch {
      existing = undefined;
    }
    const drift = existing !== serialized;
    return {
      exitCode: drift ? 1 : 0,
      summary: drift
        ? `[command.tools.generate] FAIL ${AGENT_TOOLS_FILE_RELATIVE} is stale — re-run without --check to heal`
        : `[command.tools.generate] OK ${AGENT_TOOLS_FILE_RELATIVE} is current`,
      data: { ...data, check: true, drift },
      ...(drift
        ? {
            nextSteps: [
              {
                kind: "required" as const,
                action: "re-run command.tools.generate to regenerate the file",
              },
            ],
          }
        : {}),
    };
  }

  await io.writeFile(filePath, serialized);
  return {
    exitCode: 0,
    summary: `[command.tools.generate] OK wrote ${AGENT_TOOLS_FILE_RELATIVE} — ${data.commandCount} commands, ${data.frontCount} front tools, ${data.denyCount} denied`,
    data,
  };
}
