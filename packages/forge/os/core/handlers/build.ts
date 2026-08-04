/*
<MODULE_CONTRACT>
<purpose>forge.build — execute produce commands for all artifacts declared in the active stack profile. Supports --dry-run and --json.</purpose>
<non-goals>
  <item>Do not implement dev or validate logic — those are separate handlers.</item>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0674: initial forge.build handler with profile resolution, --dry-run, and per-artifact execution.</item>
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

export interface ForgeBuildArtifactResult {
  id: string;
  command: string;
  output?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ForgeBuildResult {
  command: "forge.build";
  profileId: string;
  artifacts: ForgeBuildArtifactResult[];
}

export async function runBuild(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeBuildResult>> {
  const { workspaceRoot, logger } = context;
  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const profileIdOverride =
    typeof input.flags["profile"] === "string" ? (input.flags["profile"] as string) : undefined;

  const resolved = resolveActiveProfile(workspaceRoot, context.forgeRoot, profileIdOverride);
  if (!resolved) {
    return {
      data: {
        command: "forge.build",
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
        command: "forge.build",
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
      .filter((a) => a.produce)
      .map((a) => ({ artifactId: a.id, command: a.produce!.command, output: a.produce!.output }));
    logger.info(`[dry-run] forge.build — profile: ${profile.id}`);
    for (const cmd of commands) {
      logger.info(`  ${cmd.artifactId}: ${cmd.command}`);
    }
    return {
      data: {
        command: "forge.build",
        profileId: profile.id,
        artifacts: commands.map((c) => ({
          id: c.artifactId,
          command: c.command,
          output: c.output,
          exitCode: 0,
          stdout: "",
          stderr: "",
        })),
      },
      summary: `[dry-run] ${commands.length} produce command(s) resolved`,
    };
  }

  const results: ForgeBuildArtifactResult[] = [];
  let hasFailure = false;

  for (const artifact of profile.artifacts) {
    if (!artifact.produce) {
      logger.warn(`Skipping artifact ${artifact.id}: no produce command declared`);
      results.push({
        id: artifact.id,
        command: "",
        exitCode: 0,
        stdout: "",
        stderr: "skipped: no produce command",
      });
      continue;
    }

    const cmd = artifact.produce.command;
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: workspaceRoot });
      results.push({
        id: artifact.id,
        command: cmd,
        output: artifact.produce.output,
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
        output: artifact.produce.output,
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
      command: "forge.build",
      profileId: profile.id,
      artifacts: results,
    },
    exitCode: hasFailure ? 1 : 0,
    summary: hasFailure
      ? `forge.build: ${results.filter((r) => r.exitCode !== 0).length} artifact(s) failed`
      : `forge.build: all ${results.length} artifact(s) succeeded`,
  };
}
