/*
<MODULE_CONTRACT>
<purpose>Shared terminology resolution utility (RFC-0643). Resolves all terminology keys
from config + profile, used by both root and nested AGENTS.md generation.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0643: extracted resolveAllTerminology from agents-generate.ts and nested-agents-generate.ts to eliminate duplication.</item>
</CHANGE_SUMMARY>
*/

import { UNIVERSAL_TERMINOLOGY_KEYS } from "./profile-schema.ts";
import { resolveTerminology, type ForgeConfig } from "../config/forge-config.ts";
import type { StackProfile } from "./stack-profile.ts";

/**
 * Resolve all terminology keys (universal + profile-specific) from config and profile.
 * Used by both root AGENTS.md generation and nested AGENTS.md generation.
 */
export function resolveAllTerminology(
  config: ForgeConfig,
  profile: StackProfile | undefined,
): Record<string, string> {
  const terminology: Record<string, string> = {};
  for (const key of UNIVERSAL_TERMINOLOGY_KEYS) {
    terminology[key] = resolveTerminology(config, profile?.terminology, key);
  }
  if (profile?.terminology) {
    for (const key of Object.keys(profile.terminology)) {
      terminology[key] = resolveTerminology(config, profile.terminology, key);
    }
  }
  return terminology;
}
