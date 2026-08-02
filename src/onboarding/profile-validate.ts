/*
<MODULE_CONTRACT>
<purpose>forge.profile.validate — validates profile YAML files under packages/forge/profiles/ against the extended stack-profile schema (RFC-0638). Supports --id flag for single-profile validation.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not modify profile files — validation is read-only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0640: initial forge.profile.validate handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { stackProfileSchema } from "../profiles/stack-profile.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../types.ts";

export interface ProfileValidateResult {
  command: "forge.profile.validate";
  valid: boolean;
  profiles: Array<{
    id: string;
    valid: boolean;
    errors: string[];
    warnings: string[];
  }>;
}

export async function runProfileValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ProfileValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const filterId = input.flags["id"] as string | undefined;

  const forgeRoot = context.forgeRoot ?? path.join(workspaceRoot, "packages", "forge");
  const profilesDir = path.join(forgeRoot, "profiles");

  const profileResults: ProfileValidateResult["profiles"] = [];

  if (!fs.existsSync(profilesDir)) {
    const result: ProfileValidateResult = {
      command: "forge.profile.validate",
      valid: true,
      profiles: [],
    };
    if (outputFormat === "pretty") {
      logger.warn(`No profiles directory found at ${profilesDir}`);
    }
    return {
      data: result,
      exitCode: 0,
      summary: "forge.profile.validate: no profiles directory — 0 profiles checked",
    };
  }

  const entries = fs.readdirSync(profilesDir);
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") || entry.startsWith(".")) continue;

    const profilePath = path.join(profilesDir, entry);
    const raw = fs.readFileSync(profilePath, "utf8");

    let parsed: unknown;
    let parseError: string | null = null;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      parseError = (err as Error).message;
    }

    let profileId = entry.replace(/\.yaml$/, "");
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      profileId = (parsed as { id: string }).id;
    }

    if (filterId && profileId !== filterId) continue;

    const errors: string[] = [];
    const warnings: string[] = [];

    if (parseError) {
      errors.push(`YAML parse error: ${parseError}`);
    } else {
      const result = stackProfileSchema.safeParse(parsed);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push(`${issue.path.join(".")}: ${issue.message}`);
        }
      }
    }

    profileResults.push({
      id: profileId,
      valid: errors.length === 0,
      errors,
      warnings,
    });
  }

  const allValid = profileResults.every((p) => p.valid);

  if (outputFormat === "pretty") {
    logger.section(`Forge Profile Validate — ${profilesDir}`);
    for (const p of profileResults) {
      const icon = p.valid ? "✓" : "✖";
      const fn = p.valid ? logger.success : logger.error;
      fn(`${icon} ${p.id}: ${p.valid ? "valid" : `${p.errors.length} error(s)`}`);
      for (const err of p.errors) {
        logger.error(`  - ${err}`);
      }
    }
    if (allValid) {
      logger.success(`All ${profileResults.length} profile(s) valid.`);
    } else {
      logger.error(`${profileResults.filter((p) => !p.valid).length} profile(s) invalid.`);
    }
  }

  const result: ProfileValidateResult = {
    command: "forge.profile.validate",
    valid: allValid,
    profiles: profileResults,
  };

  return {
    data: result,
    exitCode: allValid ? 0 : 1,
    summary: allValid
      ? `forge.profile.validate: OK — ${profileResults.length} profile(s) valid`
      : `forge.profile.validate: ${profileResults.filter((p) => !p.valid).length} invalid profile(s)`,
  };
}
