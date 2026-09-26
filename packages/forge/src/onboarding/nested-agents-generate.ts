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

import * as fs from "../utils/sync-fs.ts";
import path from "node:path";
import {
  canonicalFooterOf,
  hasEditableGeneratedMarker,
  mergeEditableGenerated,
  splitEditableGenerated,
  writeFileIfChanged,
} from "../utils/index.ts";
import { resolveIo } from "../utils/io.ts";
import { discoverWorkspaces } from "./workspace-discovery.ts";
import { buildNestedAgentsMd, selectNestedTemplate, type PackageInfo } from "./nested-agents-templates.ts";
import type { ForgeConfig } from "../config/forge-config.ts";
import type { ProfileWorkspaceType } from "../profiles/profile-schema.ts";
import type { StackProfile } from "../profiles/stack-profile.ts";
import type { WorkspaceIO } from "@warpgogol/werkstatt-shared/kernel/workspace-io";
import { resolveAllTerminology } from "../profiles/terminology-utils.ts";

export interface NestedGenerateResult {
  generated: string[];
  skipped: string[];
  /** RFC-1153: files merged with a carried custom tail below the boundary. */
  preserved: string[];
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
  io?: WorkspaceIO,
): Promise<NestedGenerateResult> {
  const workspaces = discoverWorkspaces(
    workspaceRoot,
    workspaceTypes,
    config.bindings?.workspaces?.skipDirs,
  );
  const generated: string[] = [];
  const skipped: string[] = [];
  const preserved: string[] = [];
  const renderedFiles: { [relPath: string]: string } = {};
  const fio = resolveIo(io);
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

    // RFC-1153: merge instead of overwrite — the `forge:custom` boundary marks
    // the split between the generator-owned head and the preserved custom tail.
    let existing: string | null = null;
    if (ws.hasAgentsMd) {
      try {
        existing = await fio.readFile(agentsMdPath);
      } catch {
        // Unreadable — treat as absent; merge will emit a fresh file.
      }
    }
    let merged = mergeEditableGenerated(content, existing, relPath);
    if (merged === null && existing !== null && !hasEditableGeneratedMarker(existing)) {
      // RFC-0081/RFC-1153: restrictive-marker file is fully generator-owned —
      // upgrade it to the editable boundary contract (fresh render + marker).
      merged = mergeEditableGenerated(content, null, relPath);
    }
    if (merged === null) {
      skipped.push(`${relPath} (unmapped-customization)`);
      continue;
    }

    await writeFileIfChanged(agentsMdPath, merged, fio);
    generated.push(relPath);
    workspaceTypeMap[relPath] = ws.type;
    const footer = canonicalFooterOf(content);
    if (
      existing !== null &&
      splitEditableGenerated(existing, relPath, footer ?? undefined).customTail !== null
    ) {
      preserved.push(relPath);
    }
  }

  return { generated, skipped, preserved, renderedFiles, workspaceTypeMap };
}

export { discoverWorkspaces, type WorkspaceDir, type WorkspaceType } from "./workspace-discovery.ts";
export { buildNestedAgentsMd, selectNestedTemplate, type PackageInfo } from "./nested-agents-templates.ts";
