/*
<MODULE_CONTRACT>
<purpose>forge.assets.check — check for missing, orphaned, and unreferenced assets. Supports --dry-run, --strict, --json, --profile.</purpose>
<non-goals>
  <item>Do not implement asset listing logic — that lives in assets-list.ts.</item>
  <item>Do not import from @warpgogol/* in autonomous modules — os/core/ may import from @warpgogol/*.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0679: initial forge.assets.check handler with missing/orphaned detection, --strict, --dry-run.</item>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveActiveProfile, resolveLifecycleFlags } from "./profile-resolve.ts";
import {
  scanAssets,
  extractReferences,
  findMissingAssets,
  findOrphanedAssets,
} from "./assets-helpers.ts";

export interface AssetCheckResult {
  missing: Array<{ path: string; referencedBy: string[] }>;
  orphaned: Array<{ path: string; type: string }>;
}

export interface ForgeAssetsCheckResult {
  command: "forge.assets.check";
  profileId: string;
  check: AssetCheckResult;
  allOk: boolean;
}

export async function runAssetsCheck(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeAssetsCheckResult>> {
  const { workspaceRoot, logger } = context;
  const { dryRun, profileIdOverride } = resolveLifecycleFlags(input, context);
  const strict = input.flags["strict"] === true;

  const resolved = resolveActiveProfile(workspaceRoot, context.forgeRoot, profileIdOverride);
  if (!resolved) {
    return {
      data: {
        command: "forge.assets.check",
        profileId: "",
        check: { missing: [], orphaned: [] },
        allOk: false,
      },
      exitCode: 1,
      summary: "No active profile found. Set `profile` in forge.yaml or use --profile <id>.",
      nextSteps: [{ action: "Set profile in forge.yaml or use --profile <id>", kind: "required" }],
    };
  }

  const { profile } = resolved;

  if (!profile.assets) {
    return {
      data: {
        command: "forge.assets.check",
        profileId: profile.id,
        check: { missing: [], orphaned: [] },
        allOk: true,
      },
      exitCode: 0,
      summary: `Profile ${profile.id} does not declare assets — nothing to check.`,
    };
  }

  const assets = await scanAssets(workspaceRoot, profile.assets, { dryRun });
  const compositionExtensions = profile.artifacts?.flatMap((a) => a.extensions) ?? [];
  const refMap = await extractReferences(workspaceRoot, profile.assets, compositionExtensions);

  const missing = findMissingAssets(refMap, assets);
  const orphaned = findOrphanedAssets(assets, refMap);

  const hasMissing = missing.length > 0;
  const hasOrphaned = orphaned.length > 0;
  const allOk = !hasMissing && (!hasOrphaned || !strict);

  if (hasMissing) {
    for (const m of missing) {
      logger.error(`  missing: ${m.path} (referenced by ${m.referencedBy.join(", ")})`);
    }
  }
  if (hasOrphaned) {
    for (const o of orphaned) {
      if (strict) {
        logger.error(`  orphaned: ${o.path} (${o.type})`);
      } else {
        logger.warn(`  orphaned: ${o.path} (${o.type})`);
      }
    }
  }

  if (allOk) {
    logger.success(`  all assets OK`);
  }

  const parts: string[] = [];
  if (hasMissing) parts.push(`${missing.length} missing`);
  if (hasOrphaned) parts.push(`${orphaned.length} orphaned`);
  const summary = parts.length === 0 ? "all assets OK" : parts.join(", ");

  return {
    data: {
      command: "forge.assets.check",
      profileId: profile.id,
      check: { missing, orphaned },
      allOk,
    },
    exitCode: allOk ? 0 : 1,
    summary: dryRun ? `[dry-run] ${summary}` : summary,
  };
}
