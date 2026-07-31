/*
<MODULE_CONTRACT>
<purpose>Shared nested AGENTS.md generation logic (RFC-0611). Discovery + package.json
metadata extraction + edit guard + write (or render-only in dryRun). Reused by
runAgentsGenerate, runUpgrade, and runDoctor (staleness check via dryRun).</purpose>
<non-goals>
  <item>Do not generate AGENTS.md for non-workspace directories (no package.json).</item>
  <item>Do not overwrite hand-written AGENTS.md files (no generated marker).</item>
  <item>Do not add workspace-type detection rules — those live in workspace-discovery.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0611: initial shared nested generation function with dryRun support.</item>
  <item>Enriched template: read package.json metadata and pass to buildNestedAgentsMd for content-rich output.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { writeFileIfChanged } from "../utils/index.ts";
import { discoverWorkspaces, type WorkspaceDir } from "./workspace-discovery.ts";
import { buildNestedAgentsMd, type PackageInfo } from "./nested-agents-templates.ts";
import type { ForgeConfig } from "../config/forge-config.ts";

export interface NestedGenerateResult {
  generated: string[];
  skipped: string[];
  renderedFiles: { [relPath: string]: string };
}

function readPackageInfo(workspaceRoot: string, wsPath: string): PackageInfo | undefined {
  const pkgJsonPath = path.join(workspaceRoot, wsPath, "package.json");
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf8");
    return JSON.parse(raw) as PackageInfo;
  } catch {
    return undefined;
  }
}

export async function generateNestedAgentsMd(
  workspaceRoot: string,
  config: ForgeConfig,
  dryRun: boolean,
): Promise<NestedGenerateResult> {
  const workspaces = discoverWorkspaces(workspaceRoot);
  const generated: string[] = [];
  const skipped: string[] = [];
  const renderedFiles: { [relPath: string]: string } = {};

  for (const ws of workspaces) {
    const agentsMdPath = path.join(workspaceRoot, ws.path, "AGENTS.md");
    const packageInfo = readPackageInfo(workspaceRoot, ws.path);
    const content = buildNestedAgentsMd(ws, config, packageInfo);
    const relPath = path.join(ws.path, "AGENTS.md");

    if (dryRun) {
      renderedFiles[relPath] = content;
      continue;
    }

    if (ws.hasAgentsMd && !ws.isGenerated) {
      skipped.push(`${relPath} (hand-written)`);
      continue;
    }

    await writeFileIfChanged(agentsMdPath, content);
    generated.push(relPath);
  }

  return { generated, skipped, renderedFiles };
}

export { discoverWorkspaces, type WorkspaceDir, type WorkspaceType } from "./workspace-discovery.ts";
export { buildNestedAgentsMd, type PackageInfo } from "./nested-agents-templates.ts";
