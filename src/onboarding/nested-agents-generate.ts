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
  <item>RFC-0640: accept optional workspaceTypes from profile and pass to discoverWorkspaces for profile-driven detection.</item>
  <item>RFC-0643: return workspaceTypeMap for per-file workspace type metadata in details field.</item>
  <item>RFC-0643: use selectNestedTemplate for profile-driven nested templates with terminology substitution.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <history>RFC-0611</history>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { writeFileIfChanged } from "../utils/index.ts";
import { discoverWorkspaces } from "./workspace-discovery.ts";
import { buildNestedAgentsMd, selectNestedTemplate, type PackageInfo } from "./nested-agents-templates.ts";
import type { ForgeConfig } from "../config/forge-config.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";
import type { StackProfile } from "../profiles/stack-profile.ts";
import { resolveAllTerminology } from "../profiles/terminology-utils.ts";

export interface NestedGenerateResult {
  generated: string[];
  skipped: string[];
  renderedFiles: { [relPath: string]: string };
  workspaceTypeMap?: { [relPath: string]: string };
}

export function readPackageInfo(workspaceRoot: string, wsPath: string): PackageInfo | undefined {
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
  const workspaces = discoverWorkspaces(
    workspaceRoot,
    workspaceTypes,
    config.bindings?.workspaces?.skipDirs,
  );
  const generated: string[] = [];
  const skipped: string[] = [];
  const renderedFiles: { [relPath: string]: string } = {};
  const workspaceTypeMap: { [relPath: string]: string } = {};

  // RFC-0643: resolve terminology from config + profile for nested template substitution
  const profile = config.profile as StackProfile | undefined;
  const terminology = resolveAllTerminology(config, profile);

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
