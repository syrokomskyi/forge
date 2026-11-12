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
  <item>RFC-1500: step 2 — forge.create adopts the fixed branch model</item>
  <item>RFC-1500: link branch-model guide in committed NEXT_STEPS.md (review r1)</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-08 findings

F1 code-only anchor scan (markdown fences never declare anchors); F2 generated index as a re-verified hint, scan on any miss; F3 RFC-IMP-16 asserted through rfc.implement.stamp; F4 forge create patches only absent/null keys; F5 type: refs normalized; F6/F10/F11 capture existence via existsSync, future recordedAt and workspace-escaping paths are CORR-07; F7 V-55 reuses criteriaEval; F8 validator inventory regenerated; F9 binding-driven reads; F12 git listing, index hint, create patch tests; DEV-1 single sidecar spelling; DEV-2 output field dropped.</item>
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-09 findings

N1 index-hint rows count only for files in the workspace listing; N2 forge create leaves exempt repositories unbound; N3 listing test stages a file. Record DEV-3/DEV-4 amendments (CORR-07 future/escaping captures, index as re-verified hint) in the RFC Deviations section.</item>
  <history>RFC-0544, RFC-0548, RFC-0550, RFC-0640, RFC-0643, RFC-0664, RFC-0877, RFC-1097, RFC-1224</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { resolveIo } from "../utils/io.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runScaffoldProject } from "./scaffold-project.ts";
import { runInit, type InitResult, type InitDomainFields } from "./init.ts";
import { runAgentsGenerate } from "./agents-generate.ts";
import { scaffoldMemoryLayer } from "./memory-scaffold.ts";
import {
  loadForgeConfig,
  serializeForgeConfig,
  applyForgeYamlPatches,
  resolveForgeRoot,
  resolvePackageManager,
  applyCliBindingDefaults,
  type ForgeYamlPatch,
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
  flow?:
    | { status: "adopted"; develop: string; main: string; tags: string[] }
    | { status: "skipped"; reason: "no-flow-flag" | "git-init-failed" | "commit-failed" }
    | { status: "refused"; ruleId: string; message: string };
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
    if (profile.compass) {
      fields.compass = profile.compass;
    }
    if (profile.nextSteps) {
      fields.nextSteps = profile.nextSteps;
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
 * Directories that are allowed in an otherwise empty target directory.
 * Only these are tolerated when checking for emptiness.
 */
const ALLOWED_EXISTING_DIRS = new Set([".git"]);


/**
 * RFC-1578: bind a profile-shipped correctness manifest in forge.yaml — only
 * keys that are absent or null are written, so an operator-set
 * `correctnessManifest`, `correctness.mode`, or `correctness.tier` survives.
 * Returns null when nothing needs patching (or the document cannot be patched).
 */
export function correctnessBindingPatch(raw: string, manifestRel: string): string | null {
  let current: Record<string, unknown> = {};
  try {
    current = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const bindingsPaths = ((current["bindings"] as Record<string, unknown> | undefined)?.["paths"] ??
    {}) as Record<string, unknown>;
  const section = (current["correctness"] ?? {}) as Record<string, unknown>;
  // An exempt repository declares no manifest (CORR-02) — leave it untouched.
  if (section["mode"] === "exempt") return null;
  const patches: ForgeYamlPatch[] = [];
  if (bindingsPaths["correctnessManifest"] == null) {
    patches.push({ path: ["bindings", "paths", "correctnessManifest"], value: manifestRel });
  }
  if (section["mode"] == null) patches.push({ path: ["correctness", "mode"], value: "warn" });
  if (section["tier"] == null) patches.push({ path: ["correctness", "tier"], value: "standard" });
  if (patches.length === 0) return null;
  return applyForgeYamlPatches(raw, patches);
}

export async function runCreate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CreateCommandResult>> {
  const { logger, outputFormat } = context;
  const fio = resolveIo(context.io);
  const inPlace = input.flags["in-place"] as boolean | undefined;
  const nameOverride = input.flags["name"] as string | undefined;
  const profile = input.flags["profile"] as string | undefined;
  const packageManager = (input.flags["package-manager"] as string | undefined) ?? "pnpm";
  const template = input.flags["template"] as string | undefined;

  const errors: string[] = [];

  const passNextSteps: ForgeNextStep[] = [
    { action: "Run /forge-bootstrap immediately to configure language, register, and stack bindings", kind: "required" },
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

  // 6. Strict empty-directory check (RFC-0877)
  // The target directory must be empty (only .git/ is tolerated).
  // If any other files or directories exist, refuse to scaffold.
  let dirEntries: string[];
  try {
    dirEntries = (await fio.readdir(targetDir)).map((e) => e.name);
  } catch {
    dirEntries = [];
  }
  const unexpectedEntries = dirEntries.filter((e) => !ALLOWED_EXISTING_DIRS.has(e));
  if (unexpectedEntries.length > 0) {
    const msg = `Directory is not empty. Found: ${unexpectedEntries.slice(0, 10).join(", ")}${unexpectedEntries.length > 10 ? ` (and ${unexpectedEntries.length - 10} more)` : ""}. The target directory must be empty. Refusing to scaffold.`;
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

  // 6.5. Initialize git repo with main branch (if not already initialized)
  // This is a hard guard — forge.create programmatically ensures main branch,
  // so greenfield projects don't depend on the agent running git init correctly.
  const gitDir = path.join(targetDir, ".git");
  let gitInitialized = await fio.exists(gitDir);
  if (!gitInitialized) {
    const gitInit = await fio.exec("git", ["init", "--initial-branch=main"], { cwd: targetDir });
    if (gitInit.exitCode === 0) {
      gitInitialized = true;
      if (outputFormat === "pretty") {
        logger.info("Initialized git repository with main branch");
      }
    } else {
      if (outputFormat === "pretty") {
        logger.warn("Failed to initialize git repository — run 'git init --initial-branch=main' manually");
      }
    }
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
      logger.error(`Init failed with ${initResult.errors.length} error${initResult.errors.length === 1 ? "" : "s"}:`);
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
    if (await fio.exists(forgeYamlPath)) {
      try {
        const pm = resolvePackageManager(packageManager);
        const commandDefaults = applyCliBindingDefaults(pm);
        // RFC-1224: patch the document init just wrote instead of re-serializing —
        // preserves comments/formatting and any schema-unknown sections.
        const raw = await fio.readFile(forgeYamlPath);
        const patched = applyForgeYamlPatches(raw, [
          { path: ["project", "packageManager"], value: pm },
          ...Object.entries(commandDefaults).map(([key, value]) => ({
            path: ["bindings", "commands", key],
            value,
          })),
        ]);
        if (patched !== null) {
          await fio.writeFile(forgeYamlPath, patched);
        } else {
          const config = loadForgeConfig(targetDir);
          config.project.packageManager = pm;
          if (config.bindings) {
            config.bindings.commands = commandDefaults;
          }
          // RFC-1118: serializeForgeConfig writes the declared profile id verbatim —
          // never the resolved StackProfile object, never drops an unresolvable id.
          await fio.writeFile(forgeYamlPath, stringifyYaml(serializeForgeConfig(config)));
        }
      } catch {
        // Post-processing is best-effort — init already wrote a valid config
      }
    }
  }

  // 11.5. RFC-1578: a profile that ships docs/correctness.yaml binds it — profiles
  // cannot write forge.yaml themselves, so the manifest binding and the default
  // correctness section are patched in here (mode warn until the product's own
  // retrofit flips enforce).
  {
    const forgeYamlPath = path.join(targetDir, "forge.yaml");
    const manifestRel = "docs/correctness.yaml";
    if ((await fio.exists(path.join(targetDir, manifestRel))) && (await fio.exists(forgeYamlPath))) {
      try {
        const raw = await fio.readFile(forgeYamlPath);
        const patched = correctnessBindingPatch(raw, manifestRel);
        if (patched !== null) await fio.writeFile(forgeYamlPath, patched);
      } catch {
        // Best-effort like step 11 — correctness.manifest.validate reports CORR-01 when unbound.
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

  // 13. Write NEXT_STEPS.md (RFC-0550); RFC-1125: profile may override via nextSteps field
  const nextStepsPath = path.join(targetDir, "NEXT_STEPS.md");
  // RFC-1500 step 5: every written NEXT_STEPS.md links the consumer guide.
  const flowDocFooter = `
The fixed branch model is described in \`packages/forge/docs/branch-model.md\` in the Forge package — branches, sessions, integration, releases, and outbound rules.
`;
  const nextStepsContent = initDomainFields.nextSteps ?? `# Next Steps

Your Forge project is ready. The next step is mandatory: run \`/forge-bootstrap\` to configure your project interactively.

## Step 1: Configure your project (required)

Run \`/forge-bootstrap\` now. It will ask you:

- Which language the AI should communicate with you in
- Which language project documentation should be written in (defaults to English)
- Whether you prefer a business or creative working style
- Your name and how you want to be addressed
- Your stack configuration (or migrate an existing project)

This step is required before any work begins — it sets up language preferences, communication style, and project bindings.

## Step 2: Start creating

After configuration, tell the AI agent what you want to build. Describe your idea in your own words — a website, a game, a blog, a tool — and the system will set everything up and start creating with you.

## Alternative: Bring your existing project

If you already have a project elsewhere and want to move it into Forge, tell the AI agent:

> I want to bring my existing project into Forge.

The system will guide you through the process — it detects your project type, migrates the code (including \`.env\` and git-ignored files), optionally transfers git history, and verifies the build.
`;
  await fio.writeFile(nextStepsPath, `${nextStepsContent}${flowDocFooter}`);

  // 14. RFC-1500: adopt the fixed branch model — unless --no-flow.
  // One scaffold commit on main, then the flow.install handler in process.
  const noFlow = input.flags["no-flow"] === true;
  let flow: CreateCommandResult["flow"];
  let flowExitCode = 0;

  const manualFlowEntry = `

## Adopt the fixed branch model

This repository is not on the fixed branch model yet. To adopt it, run by hand:

\`\`\`sh
git add -A && git commit -m "chore: scaffold ${name} with forge create"
pnpm exec forge flow.install
\`\`\`
`;

  const appendManualFlowEntry = async (): Promise<void> => {
    await fio.writeFile(nextStepsPath, `${nextStepsContent}${flowDocFooter}${manualFlowEntry}`);
  };

  if (noFlow) {
    flow = { status: "skipped", reason: "no-flow-flag" };
    await appendManualFlowEntry();
  } else if (!gitInitialized) {
    flow = { status: "skipped", reason: "git-init-failed" };
    if (outputFormat === "pretty") {
      logger.warn("Skipping flow adoption — git init failed earlier. NEXT_STEPS.md names the manual commands.");
    }
    await appendManualFlowEntry();
  } else {
    const add = await fio.exec("git", ["add", "-A"], { cwd: targetDir });
    const commit =
      add.exitCode === 0
        ? await fio.exec("git", ["commit", "-m", `chore: scaffold ${name} with forge create`], {
            cwd: targetDir,
            env: { FORGE_FLOW_COMMIT: "create" },
          })
        : add;
    if (commit.exitCode !== 0) {
      flow = { status: "skipped", reason: "commit-failed" };
      if (outputFormat === "pretty") {
        logger.warn("Scaffold commit failed — skipping flow adoption. NEXT_STEPS.md names the manual commands.");
        logger.warn(`  ${commit.stderr.trim() || commit.stdout.trim()}`);
      }
      await appendManualFlowEntry();
    } else {
      const { runFlowInstall } = await import("../../os/flow/handlers/flow-install.ts");
      const installResult = await runFlowInstall({ argv: [], flags: {} }, childContext);
      if (installResult.exitCode !== 0) {
        const refused = /\[flow\.install\] refused: (\S+) (.*)$/.exec(installResult.summary ?? "");
        flow = {
          status: "refused",
          ruleId: refused?.[1] ?? "FLOW-INSTALL",
          message: refused?.[2] ?? installResult.summary ?? "flow.install failed",
        };
        flowExitCode = 1;
      } else {
        const develop = await fio.exec("git", ["rev-parse", "develop"], { cwd: targetDir });
        const main = await fio.exec("git", ["rev-parse", "main"], { cwd: targetDir });
        const tagList = await fio.exec("git", ["tag", "--list", "v*"], { cwd: targetDir });
        flow = {
          status: "adopted",
          develop: develop.stdout.trim(),
          main: main.stdout.trim(),
          tags: tagList.stdout
            .split("\n")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        };
        if (outputFormat === "pretty") {
          logger.success(`Fixed branch model installed — develop checked out, ${flow.tags.length} baseline tag(s)`);
        }
      }
    }
  }

  // 15. Collect filesCreated
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
      flow,
    },
    nextSteps:
      flowExitCode !== 0
        ? [{ action: "flow.install refused — fix the refusal above, then run pnpm exec forge flow.install", kind: "required" }]
        : passNextSteps,
    exitCode: flowExitCode,
    summary: `forge.create: OK — created ${name} with ${filesCreated.length} files${flow ? ` (flow: ${flow.status})` : ""}`,
  };
}
