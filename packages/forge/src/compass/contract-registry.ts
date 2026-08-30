/*
<MODULE_CONTRACT>
<purpose>Compass contract block registry — loads built-in and pack-declared block specs from forge.plugin.yaml manifests. Declarative data only, no executable hooks (RFC-0943).</purpose>
<non-goals>
  <item>Do not execute pack-provided validate() functions — block specs are declarative data interpreted by compass.validate.</item>
  <item>Do not import from os/ or kernel modules — this is a portable contract module.</item>
  <item>Do not handle FORBIDDEN_PATTERNS — the negative list stays hardcoded in compass-inventory.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0943: initial contract registry with built-in specs and pack-declared block loading.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import picomatch from "picomatch";
import type { ForgeConfig } from "../config/forge-config.ts";
import { forgePluginManifestSchema } from "../plugin/forge-plugin-manifest.ts";
import type {
  CompassContractBlockSpec,
  CompassContractRegistry,
  CompassContractRegistryEntry,
} from "./types.ts";

const BUILT_IN_SPECS: CompassContractBlockSpec[] = [
  {
    blockId: "module-contract",
    requiredFor: [
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "packages/**/*.astro",
      "packages/**/*.js",
      "packages/**/*.mjs",
      "services/**/*.ts",
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "apps/**/*.astro",
    ],
    requiredTags: [{ name: "purpose", minWords: 10 }, { name: "non-goals" }],
  },
  {
    blockId: "change-summary",
    requiredFor: [
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "packages/**/*.astro",
      "packages/**/*.js",
      "packages/**/*.mjs",
      "services/**/*.ts",
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "apps/**/*.astro",
    ],
    requiredTags: [],
  },
];

export function getBuiltInSpecs(): CompassContractBlockSpec[] {
  return BUILT_IN_SPECS;
}

export function loadContractRegistry(
  workspaceRoot: string,
  config?: ForgeConfig,
): CompassContractRegistry {
  const pack: CompassContractRegistryEntry[] = [];
  const seenBlockIds = new Set<string>();

  if (config?.skillPacks) {
    for (const skillPack of config.skillPacks) {
      const packDir = path.resolve(workspaceRoot, skillPack.dir);
      const manifestPath = path.join(packDir, "forge.plugin.yaml");
      if (!fs.existsSync(manifestPath)) continue;

      let manifestRaw: string;
      try {
        manifestRaw = fs.readFileSync(manifestPath, "utf-8");
      } catch {
        continue;
      }

      let manifestParsed: unknown;
      try {
        manifestParsed = parseYaml(manifestRaw);
      } catch {
        continue;
      }

      const result = forgePluginManifestSchema.safeParse(manifestParsed);
      if (!result.success) continue;

      const manifest = result.data;
      const blocks = manifest.extensionPoints?.compass?.contract?.blocks;
      if (!blocks || blocks.length === 0) continue;

      for (const block of blocks) {
        if (seenBlockIds.has(block.blockId)) {
          throw new Error(
            `COMPASS-PLUGIN-DUP-01: duplicate blockId "${block.blockId}" declared by pack "${manifest.id}" — already declared by another pack. Each blockId must be unique across all packs.`,
          );
        }
        seenBlockIds.add(block.blockId);
        pack.push({
          blockId: block.blockId,
          requiredFor: block.requiredFor,
          requiredTags: block.requiredTags,
          packId: manifest.id,
        });
      }
    }
  }

  return {
    builtIn: BUILT_IN_SPECS,
    pack,
  };
}

export function fileMatchesGlobs(filePath: string, globs: string[]): boolean {
  const matchers = globs.map((g) => picomatch(g, { dot: true }));
  return matchers.some((m) => m(filePath));
}

export function findApplicablePackSpecs(
  registry: CompassContractRegistry,
  filePath: string,
): CompassContractRegistryEntry[] {
  return registry.pack.filter((spec) => fileMatchesGlobs(filePath, spec.requiredFor));
}
