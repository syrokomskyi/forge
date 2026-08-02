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
  <item>RFC-0640: accept optional workspaceTypes from profile and pass to discoverWorkspaces for profile-driven detection.</item>
  <item>RFC-0643: return workspaceTypeMap for per-file workspace type metadata in details field.</item>
  <item>RFC-0643: use selectNestedTemplate for profile-driven nested templates with terminology substitution.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { writeFileIfChanged } from "../utils/index.ts";
import { discoverWorkspaces, type WorkspaceDir } from "./workspace-discovery.ts";
import { buildNestedAgentsMd, selectNestedTemplate, type PackageInfo } from "./nested-agents-templates.ts";
import type { ForgeConfig } from "../config/forge-config.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";
import type { StackProfile } from "../profiles/stack-profile.ts";
import { resolveTerminology } from "../config/forge-config.ts";

export interface NestedGenerateResult {
  generated: string[];
  skipped: string[];
  renderedFiles: { [relPath: string]: string };
  workspaceTypeMap?: { [relPath: string]: string };
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
  workspaceTypes?: ProfileWorkspaceType[],
): Promise<NestedGenerateResult> {
  const workspaces = discoverWorkspaces(workspaceRoot, workspaceTypes);
  const generated: string[] = [];
  const skipped: string[] = [];
  const renderedFiles: { [relPath: string]: string } = {};
  const workspaceTypeMap: { [relPath: string]: string } = {};

  // RFC-0643: resolve terminology from config + profile for nested template substitution
  const profile = config.profile as StackProfile | undefined;
  const terminology: Record<string, string> = {};
  for (const key of ["artifact", "artifactPlural", "module", "source", "output", "verify", "operator"]) {
    terminology[key] = resolveTerminology(config, profile?.terminology, key);
  }
  if (profile?.terminology) {
    for (const key of Object.keys(profile.terminology)) {
      terminology[key] = resolveTerminology(config, profile.terminology, key);
    }
  }

  for (const ws of workspaces) {
    const agentsMdPath = path.join(workspaceRoot, ws.path, "AGENTS.md");
    const packageInfo = readPackageInfo(workspaceRoot, ws.path);
    const fallback = buildNestedAgentsMd(ws, config, packageInfo);

    // RFC-0643: use profile-driven template when available
    const wsType = workspaceTypes?.find((wt) => wt.id === ws.type);
    const content = selectNestedTemplate(wsType, profile, terminology, fallback);
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
    workspaceTypeMap[relPath] = ws.type;
  }

  return { generated, skipped, renderedFiles, workspaceTypeMap };
}

export { discoverWorkspaces, type WorkspaceDir, type WorkspaceType } from "./workspace-discovery.ts";
export { buildNestedAgentsMd, selectNestedTemplate, type PackageInfo } from "./nested-agents-templates.ts";
