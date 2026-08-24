/*
<MODULE_CONTRACT>
<purpose>ForgePluginManifest — pack identity contract for project-declared skill packs (RFC-0941). Strict Zod schema with no extra fields.</purpose>
<non-goals>
  <item>Do not add extensionPoints, forgeRange, commands, or skills fields — deferred until real use cases emerge.</item>
  <item>Do not replace forge.yaml bindings — the manifest declares pack identity only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0941: initial ForgePluginManifest interface and Zod schema.</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const forgePluginManifestSchema = z
  .object({
    id: z
      .string()
      .regex(KEBAB_CASE_REGEX, "id must be kebab-case (lowercase letters, digits, hyphens)"),
    version: z
      .string()
      .regex(SEMVER_REGEX, "version must be a valid semver string (e.g. 1.0.0)"),
  })
  .strict();

export interface ForgePluginManifest {
  id: string;
  version: string;
}
