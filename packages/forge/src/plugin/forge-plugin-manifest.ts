/*
<MODULE_CONTRACT>
<purpose>ForgePluginManifest — pack identity contract for project-declared skill packs (RFC-0941). Strict Zod schema with optional extensionPoints (RFC-0943).</purpose>
<non-goals>
  <item>Do not add forgeRange, commands, or skills fields — deferred until real use cases emerge.</item>
  <item>Do not replace forge.yaml bindings — the manifest declares pack identity and extension points only.</item>
  <item>Do not allow pack-provided validate() functions — extension points are declarative data, not executable code.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0941: initial ForgePluginManifest interface and Zod schema.</item>
  <item>RFC-0943: added optional extensionPoints.compass.contract field for declarative Compass contract block specs.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const compassContractBlockSpecSchema = z.object({
  blockId: z
    .string()
    .regex(KEBAB_CASE_REGEX, "blockId must be kebab-case (lowercase letters, digits, hyphens)"),
  requiredFor: z.array(z.string().min(1)).min(1),
  requiredTags: z
    .array(
      z.object({
        name: z.string().min(1),
        minWords: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

const compassContractExtensionPointSchema = z.object({
  blocks: z.array(compassContractBlockSpecSchema),
});

const extensionPointsSchema = z
  .object({
    compass: z
      .object({
        contract: compassContractExtensionPointSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const forgePluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(KEBAB_CASE_REGEX, "id must be kebab-case (lowercase letters, digits, hyphens)"),
    version: z.string().regex(SEMVER_REGEX, "version must be a valid semver string (e.g. 1.0.0)"),
    extensionPoints: extensionPointsSchema.optional(),
  })
  .strict();

export interface ForgePluginManifest {
  id: string;
  version: string;
  extensionPoints?: {
    compass?: {
      contract?: {
        blocks: Array<{
          blockId: string;
          requiredFor: string[];
          requiredTags?: Array<{ name: string; minWords?: number }>;
        }>;
      };
    };
  };
}
