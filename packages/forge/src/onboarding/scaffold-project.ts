/*
<MODULE_CONTRACT>
<purpose>forge.scaffold — creates a working pnpm + Turborepo monorepo from a stack profile in an empty directory.</purpose>
<non-goals>
  <item>Do not scaffold into non-empty directories — refuse with exit 1.</item>
  <item>Do not add a --force flag — ever.</item>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0392: initial forge.scaffold handler.</item>
  <item>RFC-0542: populate nextSteps in forge.scaffold result.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { listStackProfiles, type StackProfile } from "../profiles/stack-profile.ts";
import { resolveForgeRoot } from "../config/forge-config.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeNextStep,
  ForgeRuntimeContext,
} from "../types.ts";

interface ScaffoldProjectResult {
  command: string;
  status: "pass" | "fail";
  profile: string;
  created: string[];
  installLog: string[];
  errors: string[];
}

export async function runScaffoldProject(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ScaffoldProjectResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const profileId = input.flags["profile"] as string | undefined;
  const projectName = input.flags["name"] as string | undefined;

  const created: string[] = [];
  const installLog: string[] = [];
  const errors: string[] = [];

  // Validate required flags
  if (!profileId) {
    return fail("forge.scaffold", "", "Missing required flag: --profile", errors, outputFormat, logger);
  }
  if (!projectName) {
    return fail("forge.scaffold", profileId, "Missing required flag: --name", errors, outputFormat, logger);
  }

  // Validate kebab-case project name
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(projectName)) {
    return fail("forge.scaffold", profileId, `Project name "${projectName}" is not kebab-case`, errors, outputFormat, logger);
  }

  // Refuse non-empty directories
  const entries = fs.readdirSync(workspaceRoot);
  if (entries.length > 0) {
    return fail(
      "forge.scaffold",
      profileId,
      `Directory is not empty (contains: ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? "…" : ""}). Refusing to scaffold.`,
      errors,
      outputFormat,
      logger,
    );
  }

  // Load profiles and find the requested one
  let forgeRoot: string;
  if (context.forgeRoot) {
    forgeRoot = context.forgeRoot;
  } else {
    try {
      forgeRoot = resolveForgeRoot(workspaceRoot);
    } catch (err) {
      // In autonomous mode, forgeRoot may be the cwd itself
      forgeRoot = workspaceRoot;
    }
  }

  let profiles: StackProfile[];
  try {
    profiles = listStackProfiles(forgeRoot);
  } catch (err) {
    return fail("forge.scaffold", profileId, `Failed to load profiles: ${(err as Error).message}`, errors, outputFormat, logger);
  }

  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    const available = profiles.map((p) => p.id).join(", ");
    return fail("forge.scaffold", profileId, `Unknown profile "${profileId}". Available: ${available}`, errors, outputFormat, logger);
  }

  // Create workspace directories
  for (const dir of profile.workspace.dirs) {
    const dirPath = path.join(workspaceRoot, dir);
    fs.mkdirSync(dirPath, { recursive: true });
    created.push(`${dir}/`);
  }

  // Create workspace files
  for (const file of profile.workspace.files) {
    const filePath = path.join(workspaceRoot, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content, "utf8");
    created.push(file.path);
  }

  // Run install commands
  for (const cmd of profile.install) {
    try {
      execSync(cmd, { cwd: workspaceRoot, stdio: "pipe", timeout: 60000 });
      installLog.push(`${cmd} — ok`);
    } catch (err) {
      const stderr = (err as Error).message;
      errors.push(`Install step failed: ${cmd}\n${stderr}`);
      if (outputFormat === "pretty") {
        logger.error(`Install failed: ${cmd}`);
      }
      return {
        data: { command: "forge.scaffold", status: "fail", profile: profileId, created, installLog, errors },
        exitCode: 1,
        summary: `forge.scaffold: failed — install step "${cmd}" failed`,
      };
    }
  }

  // Create first workspace if defined
  if (profile.firstWorkspace) {
    const wsPath = profile.firstWorkspace.path.replace("my-site", projectName).replace("my-game", projectName);
    const wsDir = path.join(workspaceRoot, wsPath);
    fs.mkdirSync(wsDir, { recursive: true });
    created.push(`${wsPath}/`);

    for (const file of profile.firstWorkspace.files) {
      const filePath = path.join(wsDir, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Replace placeholder names
      const content = file.content.replace(/"my-site"/g, `"${projectName}"`).replace(/"my-game"/g, `"${projectName}"`);
      fs.writeFileSync(filePath, content, "utf8");
      created.push(`${wsPath}/${file.path}`);
    }

    // Run first workspace install commands
    for (const cmd of profile.firstWorkspace.install) {
      try {
        execSync(cmd, { cwd: workspaceRoot, stdio: "pipe", timeout: 60000 });
        installLog.push(`${cmd} — ok`);
      } catch (err) {
        const stderr = (err as Error).message;
        errors.push(`Install step failed: ${cmd}\n${stderr}`);
        if (outputFormat === "pretty") {
          logger.error(`Install failed: ${cmd}`);
        }
        return {
          data: { command: "forge.scaffold", status: "fail", profile: profileId, created, installLog, errors },
          nextSteps: [{ action: "Fix the errors above and re-run forge.scaffold", kind: "required" }],
          exitCode: 1,
          summary: `forge.scaffold: failed — install step "${cmd}" failed`,
        };
      }
    }
  }

  if (outputFormat === "pretty") {
    logger.success(`Scaffolded ${profile.displayName} in ${workspaceRoot}`);
    for (const f of created) {
      logger.info(`  created: ${f}`);
    }
  }

  const nextSteps: ForgeNextStep[] =
    [
      { action: "Open the project in Windsurf", kind: "required" },
      { action: "Run forge.create to deploy skills and docs dirs", kind: "required" },
    ];
  return {
    data: { command: "forge.scaffold", status: "pass", profile: profileId, created, installLog, errors },
    nextSteps,
    exitCode: 0,
    summary: `forge.scaffold: OK — scaffolded ${profileId} with ${created.length} files`,
  };
}

function fail(
  command: string,
  profile: string,
  message: string,
  errors: string[],
  outputFormat: string,
  logger: ForgeRuntimeContext["logger"],
): ForgeCommandResult<ScaffoldProjectResult> {
  errors.push(message);
  if (outputFormat === "pretty") {
    logger.error(message);
  }
  return {
    data: { command, status: "fail", profile, created: [], installLog: [], errors },
    nextSteps: [{ action: "Fix the errors above and re-run forge.scaffold", kind: "required" }],
    exitCode: 1,
    summary: `${command}: failed — ${message}`,
  };
}
