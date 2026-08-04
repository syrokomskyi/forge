/*
<MODULE_CONTRACT>
<purpose>Shared active profile resolution for lifecycle commands (forge.dev, forge.build, forge.validate). Reads forge.yaml, resolves the active profile id, loads the profile YAML, and returns the StackProfile or null.</purpose>
<non-goals>
  <item>Do not implement command-specific logic — this is shared resolution only.</item>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0674: initial shared profile resolution for lifecycle commands.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { loadForgeConfig, resolveForgeRoot } from "../../../src/config/forge-config.ts";
import { listStackProfiles, type StackProfile } from "../../../src/profiles/stack-profile.ts";

export interface ResolvedProfile {
  profile: StackProfile;
  profilePath: string;
}

export function resolveActiveProfile(
  workspaceRoot: string,
  forgeRoot?: string,
  profileIdOverride?: string,
): ResolvedProfile | null {
  const root = forgeRoot ?? resolveForgeRoot(workspaceRoot);
  const profiles = listStackProfiles(root);

  if (profiles.length === 0) {
    return null;
  }

  let profileId: string | undefined = profileIdOverride;

  if (!profileId) {
    const config = loadForgeConfig(workspaceRoot);
    profileId = config.profile?.id;
  }

  if (!profileId) {
    return null;
  }

  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    return null;
  }

  const profilePath = path.join(root, "profiles", `${profileId}.yaml`);
  return { profile, profilePath };
}
