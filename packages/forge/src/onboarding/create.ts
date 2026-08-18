/*
<MODULE_CONTRACT>
<purpose>forge.create — in-place project scaffolding. Composes forge.scaffold + forge.init + package-manager post-processing into one command. Scaffolds directly into the current directory (no subdirectory).</purpose>
<non-goals>
  <item>Do not change forge.init or forge.scaffold contracts — forge.create delegates to them.</item>
  <item>Do not add interactive prompts — all configuration is via flags and positional args.</item>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not create subdirectories — --in-place is the only mode (RFC-0877).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0544: initial forge.create handler composing scaffold + init.</item>
  <item>RFC-0544 fix: replace double cast on runInit return with proper InitResult typing.</item>
  <item>RFC-0548: auto-run forge.agents.generate after init, update nextSteps to remove manual AGENTS.md step.</item>
  <item>RFC-0550: write NEXT_STEPS.md into project root with creator-facing guidance (greenfield vs transplant via LLM).</item>
  <item>RFC-0640: load profile domain fields and pass them to runInit for domain-aware bootstrapping.</item>
  <item>RFC-0643: pass profileId to runInit so forge.yaml gets a `profile` field.</item>
  <item>RFC-0664: scaffold memory layer (.agents/memory/) after init.</item>
  <item>RFC-0877: in-place mode only — --in-place flag required, no subdirectory creation, name derived from folder, allowlist-based conflict check.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { runScaffoldProject } from "./scaffold-project.ts";
import { runInit, type InitResult, type InitDomainFields } from "./init.ts";
import { runAgentsGenerate } from "./agents-generate.ts";
import { scaffoldMemoryLayer } from "./memory-scaffold.ts";
import {
  loadForgeConfig,
  resolveForgeRoot,
  resolvePackageManager,
  applyCliBindingDefaults,
} from "../config/forge-config.ts";
import { listStackProfiles } from "../profiles/stack-profile.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeNextStep,
  ForgeRuntimeContext,
} from "../types.ts";

interface CreateCommandResult {
  command: "forge.create";
  status: "pass" | "fail";
  projectDir: string;
  profile: string;
  filesCreated: string[];
  errors: string[];
}

/**
 * RFC-0640: Load domain fields from the selected profile.
 * Returns register, domain, terminology, and semanticBindings derived from profile.artifacts[].
 * When the profile has no domain fields, returns empty object (fallback to current behavior).
 */
function loadProfileDomainFields(profileId: string, forgeRoot: string): InitDomainFields {
  try {
    const profiles = listStackProfiles(forgeRoot);
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return {};

    const fields: InitDomainFields = {};
    fields.profileId = profileId;
    if (profile.register) {
      fields.register = profile.register;
    }
    if (profile.domain) {
      fields.domain = profile.domain;
    }
    if (profile.terminology) {
      fields.terminology = profile.terminology;
    }
    // Derive semantic binding defaults from profile.artifacts[]
    if (profile.artifacts && profile.artifacts.length > 0) {
      const semanticBindings: Record<string, string | null> = {};
      for (const artifact of profile.artifacts) {
        if (artifact.produce?.command) {
          semanticBindings.produce = artifact.produce.command;
        }
        if (artifact.validate?.command) {
          semanticBindings.validate = artifact.validate.command;
        }
      }
      if (Object.keys(semanticBindings).length > 0) {
        fields.semanticBindings = semanticBindings;
      }
    }
    return fields;
  } catch {
    return {};
  }
}

/**
 * Convert a string to kebab-case.
 * Handles camelCase, PascalCase, snake_case, spaces, and mixed separators.
 */
function toKebabCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

/**
 * Forge-specific paths that indicate an existing forge project.
 * If any of these exist in the target directory, refuse to scaffold.
 */
const FORGE_CONFLICT_PATHS = [
  "forge.yaml",
  ".agents/",
  "docs/",
  "skills/",
  "AGENTS.md",
  ".forge/",
];

export async function runCreate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CreateCommandResult>> {
  const { logger, outputFormat } = context;
  const inPlace = input.flags["in-place"] as boolean | undefined;
  const nameOverride = input.flags["name"] as string | undefined;
  const profile = input.flags["profile"] as string | undefined;
  const packageManager = (input.flags["package-manager"] as string | undefined) ?? "pnpm";
  const template = input.flags["template"] as string | undefined;

  const errors: string[] = [];

  const passNextSteps: ForgeNextStep[] = [
    { action: "Run /forge-bootstrap to configure the project interactively", kind: "optional" },
  ];
  const failNextSteps: ForgeNextStep[] = [
    { action: "Fix the errors above and re-run forge.create", kind: "required" },
  ];

  // 1. --in-place is required (RFC-0877)
  if (!inPlace) {
    const msg = "Missing required flag: --in-place";
    errors.push(msg);
    if (outputFormat === "pretty") {
      logger.error(msg);
    }
    return {
      data: { command: "forge.create", status: "fail", projectDir: "", profile: profile ?? "", filesCreated: [], errors },
      nextSteps: failNextSteps,
      exitCode: 1,
      summary: "forge.create: failed — missing --in-place flag",
    };
  }

  // 2. --profile is required (RFC-0877)
  if (!profile) {
    const msg = "Missing required flag: --profile <profile-id>";
    errors.push(msg);
    if (outputFormat === "pretty") {
      logger.error(msg);
    }
    return {
      data: { command: "forge.create", status: "fail", projectDir: "", profile: "", filesCreated: [], errors },
      nextSteps: failNextSteps,
      exitCode: 1,
      summary: "forge.create: failed — missing --profile flag",
    };
  }

  // 3. Resolve target directory — in-place mode uses workspaceRoot directly
  const targetDir = path.resolve(context.workspaceRoot);

  // 4. Derive project name from folder name if not provided
  let name: string;
  if (nameOverride) {
    name = nameOverride;
  } else {
    const folderName = path.basename(targetDir);
    name = toKebabCase(folderName);
    if (!name) {
      const msg = `Cannot derive project name from folder "${folderName}" — provide --name explicitly`;
      errors.push(msg);
      if (outputFormat === "pretty") {
        logger.error(msg);
      }
      return {
        data: { command: "forge.create", status: "fail", projectDir: targetDir, profile, filesCreated: [], errors },
        nextSteps: failNextSteps,
        exitCode: 1,
        summary: `forge.create: failed — ${msg}`,
      };
    }
  }

  // 5. Validate kebab-case
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    const msg = `Project name "${name}" is not kebab-case (expected ^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$)`;
    errors.push(msg);
    if (outputFormat === "pretty") {
      logger.error(msg);
    }
    return {
      data: { command: "forge.create", status: "fail", projectDir: targetDir, profile, filesCreated: [], errors },
      nextSteps: failNextSteps,
      exitCode: 1,
      summary: `forge.create: failed — ${msg}`,
    };
  }

  // 6. Allowlist-based conflict check (RFC-0877)
  // Refuse only forge-specific paths; tolerate everything else.
  const conflicts: string[] = [];
  for (const conflictPath of FORGE_CONFLICT_PATHS) {
    const fullPath = path.join(targetDir, conflictPath);
    if (fs.existsSync(fullPath)) {
      conflicts.push(conflictPath);
    }
  }
  if (conflicts.length > 0) {
    const msg = `Directory already contains forge artifacts: ${conflicts.join(", ")}. Refusing to scaffold.`;
    errors.push(msg);
    if (outputFormat === "pretty") {
      logger.error(msg);
    }
    return {
      data: { command: "forge.create", status: "fail", projectDir: targetDir, profile, filesCreated: [], errors },
      nextSteps: failNextSteps,
      exitCode: 1,
      summary: `forge.create: failed — ${msg}`,
    };
  }

  // 7. Resolve forge root
  let forgeRoot: string;
  if (context.forgeRoot) {
    forgeRoot = context.forgeRoot;
  } else {
    try {
      forgeRoot = resolveForgeRoot(context.workspaceRoot);
    } catch {
      forgeRoot = context.workspaceRoot;
    }
  }
  if (outputFormat === "pretty") {
    logger.info(`Using forge root: ${forgeRoot}`);
  }

  // 8. Build child context with workspaceRoot = targetDir and forgeRoot override
  const childContext: ForgeRuntimeContext = {
    ...context,
    workspaceRoot: targetDir,
    forgeRoot,
  };

  // 9. Run forge.scaffold inside target dir
  const scaffoldInput: ForgeCommandInput = {
    argv: [],
    flags: { profile, name, ...(template ? { template } : {}) },
  };
  const scaffoldResult = await runScaffoldProject(scaffoldInput, childContext);
  if (scaffoldResult.exitCode !== 0) {
    const scaffoldErrors = scaffoldResult.data?.errors ?? ["scaffold failed"];
    return {
      data: {
        command: "forge.create",
        status: "fail",
        projectDir: targetDir,
        profile,
        filesCreated: scaffoldResult.data?.created ?? [],
        errors: scaffoldErrors,
      },
      nextSteps: failNextSteps,
      exitCode: 1,
      summary: `forge.create: failed — scaffold step failed`,
    };
  }

  // 10. Run forge.init inside target dir
  // RFC-0640: load profile domain fields and pass them to runInit
  const initDomainFields = loadProfileDomainFields(profile, forgeRoot);
  const initInput: ForgeCommandInput = {
    argv: [],
    flags: {},
  };
  const initResult: InitResult = runInit(initInput, childContext, initDomainFields);

  if (outputFormat === "pretty") {
    logger.info(`Init: ${initResult.status} — ${initResult.created.length} created, ${initResult.skipped.length} skipped, ${initResult.errors.length} errors`);
    if (initResult.errors.length > 0) {
      for (const err of initResult.errors.slice(0, 3)) {
        logger.warn(`  init error: ${err}`);
      }
    }
  }

  // 10.5. Scaffold memory layer (RFC-0664) — runs regardless of init success
  const memoryScaffoldResult = scaffoldMemoryLayer(targetDir);

  if (initResult.status !== "pass") {
    if (outputFormat === "pretty") {
      logger.error(`Init failed with ${initResult.errors.length} error(s):`);
      for (const err of initResult.errors.slice(0, 5)) {
        logger.error(`  ${err}`);
      }
    }
    return {
      data: {
        command: "forge.create",
        status: "fail",
        projectDir: targetDir,
        profile,
        filesCreated: [...(scaffoldResult.data?.created ?? []), ...(initResult.created ?? []), ...memoryScaffoldResult.created],
        errors: initResult.errors ?? ["init failed"],
      },
      nextSteps: failNextSteps,
      exitCode: 1,
      summary: `forge.create: failed — init step failed`,
    };
  }

  // 11. Post-process forge.yaml if --package-manager differs from default
  if (packageManager !== "pnpm") {
    const forgeYamlPath = path.join(targetDir, "forge.yaml");
    if (fs.existsSync(forgeYamlPath)) {
      try {
        const config = loadForgeConfig(targetDir);
        const pm = resolvePackageManager(packageManager);
        config.project.packageManager = pm;
        if (config.bindings) {
          config.bindings.commands = applyCliBindingDefaults(pm);
        }
        // RFC-0643: strip loaded profile object before serializing — forge.yaml stores profile id (string), not the full profile
        const configToSerialize = { ...config } as unknown as Record<string, unknown>;
        if (typeof configToSerialize["profile"] === "object") {
          const profileObj = configToSerialize["profile"] as { id?: string };
          configToSerialize["profile"] = profileObj.id ?? configToSerialize["profile"];
        }
        fs.writeFileSync(forgeYamlPath, stringifyYaml(configToSerialize), "utf8");
      } catch {
        // Post-processing is best-effort — init already wrote a valid config
      }
    }
  }

  // 12. Auto-run forge.agents.generate (RFC-0548)
  try {
    const agentsInput: ForgeCommandInput = {
      argv: [],
      flags: {},
    };
    if (outputFormat === "pretty") {
      logger.info("Generating AGENTS.md...");
    }
    const agentsResult = await runAgentsGenerate(agentsInput, childContext);
    if (outputFormat === "pretty") {
      logger.info(`Agents.generate: ${agentsResult.exitCode === 0 ? "ok" : "failed"} — ${(agentsResult.data?.generated ?? []).length} generated, ${(agentsResult.data?.errors ?? []).length} errors`);
    }
    if (agentsResult.exitCode !== 0 && outputFormat === "pretty") {
      logger.warn("forge.agents.generate failed — AGENTS.md not generated. Run 'forge agents generate' manually after fixing the issue.");
      for (const err of (agentsResult.data?.errors ?? []).slice(0, 3)) {
        logger.warn(`  ${err}`);
      }
    }
  } catch (err) {
    if (outputFormat === "pretty") {
      logger.warn("forge.agents.generate failed — AGENTS.md not generated. Run 'forge agents generate' manually after fixing the issue.");
      logger.warn(`  ${(err as Error).message}`);
    }
  }

  // 13. Write NEXT_STEPS.md (RFC-0550)
  const nextStepsPath = path.join(targetDir, "NEXT_STEPS.md");
  const nextStepsContent = `# Next Steps

Your Forge project is ready. You have two options — just tell the AI agent what you want, and it will handle the rest.

## Option A: Start creating

Tell the AI agent what you want to build. Describe your idea in your own words — a website, a game, a blog, a tool — and the system will set everything up and start creating with you.

The agent will run \`/forge-bootstrap\` to configure your project interactively (language, stack bindings, git init).

## Option B: Bring your existing project

If you already have a project elsewhere and want to move it into Forge, tell the AI agent:

> I want to bring my existing project into Forge.

The system will guide you through the process — it detects your project type, migrates the code (including \`.env\` and git-ignored files), optionally transfers git history, and verifies the build.

---

Whichever path you choose, you don't need to run any commands. Just describe what you want in natural language, and the AI agent takes care of it.
`;
  fs.writeFileSync(nextStepsPath, nextStepsContent, "utf8");

  // 14. Collect filesCreated
  const filesCreated = [
    ...(scaffoldResult.data?.created ?? []),
    ...(initResult.created ?? []),
    ...memoryScaffoldResult.created,
    "NEXT_STEPS.md",
  ];

  if (outputFormat === "pretty") {
    logger.success(`Created project "${name}" in ${targetDir}`);
    for (const f of filesCreated) {
      logger.info(`  created: ${f}`);
    }
  }

  return {
    data: {
      command: "forge.create",
      status: "pass",
      projectDir: targetDir,
      profile,
      filesCreated,
      errors: [],
    },
    nextSteps: passNextSteps,
    exitCode: 0,
    summary: `forge.create: OK — created ${name} with ${filesCreated.length} files`,
  };
}
