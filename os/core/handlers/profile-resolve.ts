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

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveForgeRoot } from "../../../src/config/forge-config.ts";
import { listStackProfiles, type StackProfile } from "../../../src/profiles/stack-profile.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

export interface ResolvedProfile {
  profile: StackProfile;
  profilePath: string;
}

function readProfileIdFromForgeYaml(workspaceRoot: string): string | undefined {
  const configPath = path.join(workspaceRoot, "forge.yaml");
  if (!fs.existsSync(configPath)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    if (typeof parsed["profile"] === "string") {
      return parsed["profile"];
    }
    const project = parsed["project"] as Record<string, unknown> | undefined;
    if (project && Array.isArray(project["stack"]) && project["stack"].length > 0) {
      return project["stack"][0] as string;
    }
  } catch {
    // forge.yaml not parseable — no profile
  }
  return undefined;
}

export interface LifecycleFlags {
  dryRun: boolean;
  profileIdOverride?: string;
}

export function resolveLifecycleFlags(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): LifecycleFlags {
  return {
    dryRun: context.dryRun || input.flags["dry-run"] === true,
    profileIdOverride:
      typeof input.flags["profile"] === "string" ? (input.flags["profile"] as string) : undefined,
  };
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
    profileId = readProfileIdFromForgeYaml(workspaceRoot);
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
