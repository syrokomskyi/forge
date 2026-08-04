/*
<MODULE_CONTRACT>
<purpose>forge.dev — start the dev/preview server declared in the active stack profile. Supports --dry-run to print the resolved command without executing.</purpose>
<non-goals>
  <item>Do not implement build or validate logic — those are separate handlers.</item>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0674: initial forge.dev handler with profile resolution, --dry-run, and SIGINT handling.</item>
</CHANGE_SUMMARY>
*/

import { spawn } from "node:child_process";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveActiveProfile, resolveLifecycleFlags } from "./profile-resolve.ts";

export interface ForgeDevResult {
  command: "forge.dev";
  profileId: string;
  devServerCommand: string;
  port?: number;
  exitCode: number;
}

export async function runDev(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeDevResult>> {
  const { workspaceRoot, logger } = context;
  const { dryRun, profileIdOverride } = resolveLifecycleFlags(input, context);

  const resolved = resolveActiveProfile(workspaceRoot, context.forgeRoot, profileIdOverride);
  if (!resolved) {
    return {
      data: {
        command: "forge.dev",
        profileId: "",
        devServerCommand: "",
        exitCode: 1,
      },
      exitCode: 1,
      summary: "No active profile found. Set `profile` in forge.yaml or use --profile <id>.",
      nextSteps: [{ action: "Set profile in forge.yaml or use --profile <id>", kind: "required" }],
    };
  }

  const { profile } = resolved;

  if (!profile.devServer) {
    return {
      data: {
        command: "forge.dev",
        profileId: profile.id,
        devServerCommand: "",
        exitCode: 1,
      },
      exitCode: 1,
      summary: `Profile ${profile.id} does not declare a devServer.`,
      nextSteps: [{ action: `Add devServer section to profile ${profile.id}`, kind: "required" }],
    };
  }

  const { command, port } = profile.devServer;

  if (dryRun) {
    logger.info(`[dry-run] forge.dev — profile: ${profile.id}`);
    logger.info(`  command: ${command}`);
    if (port) logger.info(`  port: ${port}`);
    return {
      data: {
        command: "forge.dev",
        profileId: profile.id,
        devServerCommand: command,
        port,
        exitCode: 0,
      },
      summary: `[dry-run] ${command}`,
    };
  }

  return new Promise<ForgeCommandResult<ForgeDevResult>>((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      cwd: workspaceRoot,
    });

    const onSigint = () => {
      child.kill("SIGINT");
    };
    process.once("SIGINT", onSigint);

    child.on("close", (code) => {
      process.removeListener("SIGINT", onSigint);
      resolve({
        data: {
          command: "forge.dev",
          profileId: profile.id,
          devServerCommand: command,
          port,
          exitCode: code ?? 0,
        },
        summary: `forge.dev exited with code ${code ?? 0}`,
      });
    });

    child.on("error", (err) => {
      process.removeListener("SIGINT", onSigint);
      resolve({
        data: {
          command: "forge.dev",
          profileId: profile.id,
          devServerCommand: command,
          port,
          exitCode: 1,
        },
        exitCode: 1,
        summary: `forge.dev failed: ${err.message}`,
      });
    });
  });
}
