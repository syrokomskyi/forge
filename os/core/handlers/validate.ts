/*
<MODULE_CONTRACT>
<purpose>forge.validate — execute validate commands for all artifacts declared in the active stack profile. Supports --dry-run and --json.</purpose>
<non-goals>
  <item>Do not implement dev or build logic — those are separate handlers.</item>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0674: initial forge.validate handler with profile resolution, --dry-run, and per-artifact execution.</item>
</CHANGE_SUMMARY>
*/

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveActiveProfile } from "./profile-resolve.ts";

const execAsync = promisify(exec);

export interface ForgeValidateArtifactResult {
  id: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ForgeValidateResult {
  command: "forge.validate";
  profileId: string;
  artifacts: ForgeValidateArtifactResult[];
}

export async function runValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeValidateResult>> {
  const { workspaceRoot, logger } = context;
  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const profileIdOverride =
    typeof input.flags["profile"] === "string" ? (input.flags["profile"] as string) : undefined;

  const resolved = resolveActiveProfile(workspaceRoot, context.forgeRoot, profileIdOverride);
  if (!resolved) {
    return {
      data: {
        command: "forge.validate",
        profileId: "",
        artifacts: [],
      },
      exitCode: 1,
      summary: "No active profile found. Set `profile` in forge.yaml or use --profile <id>.",
      nextSteps: [{ action: "Set profile in forge.yaml or use --profile <id>", kind: "required" }],
    };
  }

  const { profile } = resolved;

  if (!profile.artifacts || profile.artifacts.length === 0) {
    return {
      data: {
        command: "forge.validate",
        profileId: profile.id,
        artifacts: [],
      },
      exitCode: 1,
      summary: `Profile ${profile.id} does not declare any artifacts.`,
      nextSteps: [{ action: `Add artifacts section to profile ${profile.id}`, kind: "required" }],
    };
  }

  if (dryRun) {
    const commands = profile.artifacts
      .filter((a) => a.validate)
      .map((a) => ({ artifactId: a.id, command: a.validate!.command }));
    logger.info(`[dry-run] forge.validate — profile: ${profile.id}`);
    for (const cmd of commands) {
      logger.info(`  ${cmd.artifactId}: ${cmd.command}`);
    }
    return {
      data: {
        command: "forge.validate",
        profileId: profile.id,
        artifacts: commands.map((c) => ({
          id: c.artifactId,
          command: c.command,
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
      summary: `[dry-run] ${commands.length} validate command(s) resolved`,
    };
  }

  const results: ForgeValidateArtifactResult[] = [];
  let hasFailure = false;

  for (const artifact of profile.artifacts) {
    if (!artifact.validate) {
      logger.warn(`Skipping artifact ${artifact.id}: no validate command declared`);
      results.push({
        id: artifact.id,
        command: "",
        exitCode: 0,
        stdout: "",
        stderr: "skipped: no validate command",
      });
      continue;
    }

    const cmd = artifact.validate.command;
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: workspaceRoot });
      results.push({
        id: artifact.id,
        command: cmd,
        exitCode: 0,
        stdout,
        stderr,
      });
      logger.success(`  ${artifact.id}: OK`);
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
      results.push({
        id: artifact.id,
        command: cmd,
        exitCode: e.code ?? 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
      });
      hasFailure = true;
      logger.error(`  ${artifact.id}: FAILED (exit ${e.code ?? 1})`);
    }
  }

  return {
    data: {
      command: "forge.validate",
      profileId: profile.id,
      artifacts: results,
    },
    exitCode: hasFailure ? 1 : 0,
    summary: hasFailure
      ? `forge.validate: ${results.filter((r) => r.exitCode !== 0).length} artifact(s) failed`
      : `forge.validate: all ${results.length} artifact(s) passed`,
  };
}
