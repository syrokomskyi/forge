/*
<MODULE_CONTRACT>
<purpose>forge.assets.list — list all assets declared in the active stack profile, grouped by type. Supports --dry-run, --type, --json, --profile.</purpose>
<non-goals>
  <item>Do not implement asset checking logic — that lives in assets-check.ts.</item>
  <item>Do not import from @warpgogol/* in autonomous modules — os/core/ may import from @warpgogol/*.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0679: initial forge.assets.list handler with profile resolution, --dry-run, --type filtering.</item>
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
  mergeReferences,
  type AssetEntry,
} from "./assets-helpers.ts";

export interface ForgeAssetsListResult {
  command: "forge.assets.list";
  profileId: string;
  assets: AssetEntry[];
}

export async function runAssetsList(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeAssetsListResult>> {
  const { workspaceRoot, logger } = context;
  const { dryRun, profileIdOverride } = resolveLifecycleFlags(input, context);
  const typeFilter =
    typeof input.flags["type"] === "string"
      ? (input.flags["type"] as string)
      : undefined;

  const resolved = resolveActiveProfile(
    workspaceRoot,
    context.forgeRoot,
    profileIdOverride,
  );
  if (!resolved) {
    return {
      data: {
        command: "forge.assets.list",
        profileId: "",
        assets: [],
      },
      exitCode: 1,
      summary:
        "No active profile found. Set `profile` in forge.yaml or use --profile <id>.",
      nextSteps: [
        { action: "Set profile in forge.yaml or use --profile <id>", kind: "required" },
      ],
    };
  }

  const { profile } = resolved;

  if (!profile.assets) {
    return {
      data: {
        command: "forge.assets.list",
        profileId: profile.id,
        assets: [],
      },
      exitCode: 0,
      summary: `Profile ${profile.id} does not declare assets — nothing to list.`,
    };
  }

  const assets = await scanAssets(workspaceRoot, profile.assets, {
    dryRun,
    typeFilter,
  });

  const compositionExtensions = profile.artifacts?.flatMap((a) => a.extensions) ?? [];
  const refMap = await extractReferences(
    workspaceRoot,
    profile.assets,
    compositionExtensions,
  );
  const assetsWithRefs = mergeReferences(assets, refMap);

  if (dryRun) {
    logger.info(`[dry-run] forge.assets.list — profile: ${profile.id}`);
    for (const asset of assetsWithRefs) {
      logger.info(`  ${asset.type}: ${asset.path}`);
    }
  } else {
    logger.info(`forge.assets.list — profile: ${profile.id}`);
    for (const asset of assetsWithRefs) {
      logger.info(`  ${asset.type}: ${asset.path} (${asset.size} bytes, ${asset.hash})`);
    }
  }

  return {
    data: {
      command: "forge.assets.list",
      profileId: profile.id,
      assets: assetsWithRefs,
    },
    summary: `${assetsWithRefs.length} asset(s) found${typeFilter ? ` (type: ${typeFilter})` : ""}${dryRun ? " [dry-run]" : ""}`,
  };
}
