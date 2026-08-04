/*
<MODULE_CONTRACT>
<purpose>Shared asset scanning and reference extraction logic for forge.assets.list and forge.assets.check (RFC-0679).</purpose>
<non-goals>
  <item>Do not implement command registration — that lives in core.module.ts.</item>
  <item>Do not import from @warpgogol/* in autonomous modules — os/core/ may import from @warpgogol/*.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0679: initial shared asset helpers — scanAssets, extractReferences, classifyAssetType.</item>
</CHANGE_SUMMARY>
*/

import { readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { loadWorkspaceDeps } from "./workspace-deps.ts";
import type { ProfileAsset, ProfileAssetType } from "../../../src/profiles/profile-schema.ts";

export interface AssetEntry {
  path: string;
  type: string;
  size: number;
  hash: string;
  referencedBy: string[];
}

export interface AssetReference {
  path: string;
  referencedBy: string;
}

export function classifyAssetType(filePath: string, types: ProfileAssetType[]): string | undefined {
  const ext = extname(filePath).toLowerCase();
  return types.find((t) => t.extensions.some((e) => e.toLowerCase() === ext))?.id;
}

export async function scanAssets(
  workspaceRoot: string,
  assetsConfig: ProfileAsset,
  options: { dryRun?: boolean; typeFilter?: string } = {},
): Promise<AssetEntry[]> {
  const { collectFiles, byteHashFile } = await loadWorkspaceDeps();
  const assetsDir = join(workspaceRoot, assetsConfig.dir);
  const allFiles = await collectFiles(assetsDir, {
    ignore: (name) => name.startsWith("-") || name.startsWith("old-") || name === ".DS_Store",
  });

  const filtered = allFiles
    .map((abs) => relative(workspaceRoot, abs))
    .filter((rel) => {
      if (options.typeFilter) {
        const type = classifyAssetType(rel, assetsConfig.types);
        return type === options.typeFilter;
      }
      return classifyAssetType(rel, assetsConfig.types) !== undefined;
    })
    .sort();

  const entries: AssetEntry[] = [];
  for (const relPath of filtered) {
    const absPath = join(workspaceRoot, relPath);
    let size = 0;
    let hash = "";

    if (!options.dryRun) {
      const stats = await stat(absPath);
      size = stats.size;
      hash = await byteHashFile(absPath);
    }

    entries.push({
      path: relPath,
      type: classifyAssetType(relPath, assetsConfig.types)!,
      size,
      hash,
      referencedBy: [],
    });
  }

  return entries;
}

export async function extractReferences(
  workspaceRoot: string,
  assetsConfig: ProfileAsset,
  compositionExtensions: string[],
): Promise<Map<string, string[]>> {
  const refMap = new Map<string, string[]>();

  const { collectFiles } = await loadWorkspaceDeps();
  const allFiles = await collectFiles(workspaceRoot, {
    extensions: compositionExtensions,
    ignore: (name) =>
      name.startsWith("-") ||
      name.startsWith("old-") ||
      name === "node_modules" ||
      name === "dist" ||
      name === ".turbo" ||
      name === ".cache" ||
      name === ".git",
  });

  for (const absPath of allFiles) {
    const relPath = relative(workspaceRoot, absPath);
    try {
      const content = await readFile(absPath, "utf8");

      for (const assetType of assetsConfig.types) {
        if (!assetType.referencePattern) continue;

        try {
          const regex = new RegExp(assetType.referencePattern, "g");
          let match: RegExpExecArray | null;
          const MAX_MATCHES = 1000;
          let matchCount = 0;

          while ((match = regex.exec(content)) !== null && matchCount < MAX_MATCHES) {
            matchCount++;
            const refPath = match[1] ?? match[0];
            const normalized = refPath.startsWith("/") ? refPath.slice(1) : refPath;

            const existing = refMap.get(normalized) ?? [];
            if (!existing.includes(relPath)) {
              existing.push(relPath);
            }
            refMap.set(normalized, existing);

            if (regex.lastIndex === match.index) regex.lastIndex++;
          }
        } catch {
          // Invalid regex — skip this type
        }
      }
    } catch {
      // Cannot read file — skip
    }
  }

  return refMap;
}

export function mergeReferences(assets: AssetEntry[], refMap: Map<string, string[]>): AssetEntry[] {
  return assets.map((asset) => {
    const refs = refMap.get(asset.path) ?? [];
    return { ...asset, referencedBy: refs };
  });
}

export function findMissingAssets(
  refMap: Map<string, string[]>,
  assets: AssetEntry[],
): Array<{ path: string; referencedBy: string[] }> {
  const assetPaths = new Set(assets.map((a) => a.path));
  const missing: Array<{ path: string; referencedBy: string[] }> = [];

  for (const [refPath, referencedBy] of refMap) {
    if (!assetPaths.has(refPath)) {
      missing.push({ path: refPath, referencedBy });
    }
  }

  return missing.sort((a, b) => a.path.localeCompare(b.path));
}

export function findOrphanedAssets(
  assets: AssetEntry[],
  refMap: Map<string, string[]>,
): Array<{ path: string; type: string }> {
  const referencedAssetPaths = new Set(refMap.keys());
  return assets
    .filter((a) => !referencedAssetPaths.has(a.path))
    .map((a) => ({ path: a.path, type: a.type }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
