/*
<MODULE_CONTRACT>
<purpose>Register the core forge onboarding, scaffold, and validation commands with the kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to src/ handlers.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1518: docs-drift gate PKG-HEALTH-11/12 in forge.package.health

Live-inventory docs gate: PKG-HEALTH-11 flags registered commands absent
from the package DOCS_SURFACE, PKG-HEALTH-12 flags dead x.y doc tokens.
loadCommandInventory unions the runtime registry with the generated
command manifest (getLiveCommands precedent); namespace + TLD-tail
resolution keep property paths and domains silent. Same-line
pkg-health-11/12 markers journal intentional exceptions.

Audit diff to land green: canonical forge.* names in forge docs,
leitstand.access.* expansions, registered-surface listings for
projektarchiv-operations/werkstatt-journal/werkstatt-engine, and 100+
journaled suppressions for code paths, family prefixes, and the planned
werkstatt-knowledge CLI surface.</item>
  <item>RFC-1528: docs.archive regenerates invalidated generated artifacts

After moves, invoke owner commands whose reads[] match a moved path via context.invoke (manifest generator last); report regenerated paths; degrade with a note without a kernel host.</item>
  <item>RFC-1528: extract dry-run regen gate for AC-6 evidence

shouldRunArchiveRegen makes the report-only contract a tested unit instead of an inline closure check.</item>
  <item>RFC-1528: close review findings — manifest-union command inventory for regen/preflight</item>
  <item>RFC-1528: note moved[] under-count on archiver throw (review F-10)</item>
  <history>ADR-0021, RFC-0374, RFC-0521, RFC-0539, RFC-0542, RFC-0543, RFC-0544, RFC-0546, RFC-0640, RFC-0662, RFC-0674, RFC-0678, RFC-0679, RFC-0680, RFC-0711, RFC-0733, RFC-0877, RFC-0940, RFC-1080, RFC-1088, RFC-1089, RFC-1097, RFC-1173, RFC-1230, RFC-1231, RFC-1235, RFC-1248, RFC-1251, RFC-1254, RFC-1255, RFC-1351, RFC-1354, RFC-1360, RFC-1366, RFC-1461, RFC-1500, RFC-1505, RFC-1508, RFC-1517, RFC-1522</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeNextStep,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import path from "node:path";
import { restoreTrackedLockfile, execFileSyncAdapter } from "../mission/lockfile.ts";
import { writeFileIfChanged } from "../../src/utils/fs-idempotent.ts";
import {
  FORGE_SKILLS,
  discoverPackSkills,
  type ForgeSkillEntry,
  type PackSkillEntry,
} from "../../src/registry.ts";
import { loadForgeConfig } from "../../src/config/forge-config.ts";

export async function createForgeCoreModule(): Promise<ForgeModule> {
  const { runScaffold } = await import("../../src/onboarding/scaffold.ts");
  const { runSkillValidate } = await import("../../src/validators/skill-validate.ts");
  const { runPortValidate } = await import("../../src/validators/port-validate.ts");
  const { runDoctor } = await import("../../src/onboarding/doctor.ts");
  const { runAgentsGenerate } = await import("../../src/onboarding/agents-generate.ts");
  const { runMemoryCompact } = await import("../../src/onboarding/memory-compact.ts");
  const { runScaffoldProject } = await import("../../src/onboarding/scaffold-project.ts");
  const { runUpgrade } = await import("../../src/onboarding/upgrade.ts");
  const { runCreate } = await import("../../src/onboarding/create.ts");
  const { runProfileValidate } = await import("../../src/onboarding/profile-validate.ts");
  const { runDev } = await import("./handlers/dev.ts");
  const { runBuild } = await import("./handlers/build.ts");
  const { runValidate } = await import("./handlers/validate.ts");
  const { runPinnedValidate } = await import("./handlers/pinned-validate.ts");
  const { runPinnedInit } = await import("./handlers/pinned-init.ts");
  const { runAssetsList } = await import("./handlers/assets-list.ts");
  const { runAssetsCheck } = await import("./handlers/assets-check.ts");
  const { runReleasePrepare } = await import("./handlers/release-prepare.ts");
  const { runReleasePublish } = await import("./handlers/release-publish.ts");
  const { runKnowledgeCompact } = await import("./handlers/knowledge-compact.ts");
  const { runPackageHealth } = await import("./handlers/package-health.ts");
  const { runForgeAutonomyValidate } = await import("./handlers/forge-autonomy-validate.ts");
  const { runPublicSurfaceValidate } = await import("./handlers/public-surface.ts");
  const { runFileSizeLint } = await import("./handlers/file-size-lint.ts");
  const { runCompassDocsScaffold } = await import("../compass/handlers/compass-docs-scaffold.ts");

  // RFC-1253: --compass-docs on lifecycle commands runs the corpus scaffold
  // after the primary operation (idempotent — re-invocation is a no-op).
  const maybeScaffoldCompassDocs = async (
    input: ForgeCommandInput,
    context: ForgeRuntimeContext,
    result: ForgeCommandResult,
  ): Promise<ForgeCommandResult> => {
    if (input.flags["compass-docs"] !== true) return result;
    const docs = await runCompassDocsScaffold(input, context);
    const ok = (docs.exitCode ?? 0) === 0;
    return {
      ...result,
      data: { ...(result.data as Record<string, unknown>), compassDocs: docs.data },
      exitCode: ok ? result.exitCode : 1,
      summary: result.summary
        ? `${result.summary}; compassDocs scaffold ${ok ? "applied" : "FAILED"}`
        : result.summary,
      nextSteps: [...(result.nextSteps ?? []), ...(docs.nextSteps ?? [])],
    };
  };

  const scaffoldWrapper = async (
    input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<ForgeCommandResult> => {
    const result = runScaffold(input, context);
    const nextSteps: ForgeNextStep[] =
      result.status === "pass"
        ? [
            { action: "Edit the scaffolded SKILL.md to implement your skill", kind: "required" },
            { action: "Run forge.skill.validate to check compliance", kind: "optional" },
          ]
        : [{ action: "Fix the errors above and re-run forge.port.scaffold", kind: "required" }];
    return {
      data: result,
      nextSteps,
      exitCode: result.status === "pass" ? 0 : 1,
      summary:
        result.status === "pass"
          ? `[forge.port.scaffold] OK — ${result.created.length} files created`
          : undefined,
    };
  };

  const skillValidateWrapper = async (
    _input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<ForgeCommandResult> => {
    const result = runSkillValidate({ flags: {} }, context);
    return {
      data: result,
      exitCode: result.status === "pass" ? 0 : 1,
      summary: result.status === "pass" ? `[forge.skill.validate] OK — 0 violations` : undefined,
    };
  };

  const portValidateWrapper = async (
    input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<ForgeCommandResult> => {
    const result = runPortValidate(input, context);
    return {
      data: result,
      exitCode: result.status === "pass" ? 0 : 1,
      summary: result.status === "pass" ? `[forge.port.validate] OK — 0 violations` : undefined,
    };
  };
  const skillListWrapper = async (
    _input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<
    ForgeCommandResult<{
      command: string;
      skills: (ForgeSkillEntry | PackSkillEntry)[];
      count: number;
    }>
  > => {
    const forgeSkills = FORGE_SKILLS;
    // RFC-0539: Include pack skills from declared skillPacks
    let packSkills: PackSkillEntry[] = [];
    try {
      const config = loadForgeConfig(context.workspaceRoot);
      packSkills = discoverPackSkills(context.workspaceRoot, config);
    } catch {
      // Config not found or invalid — skip pack skills
    }
    const skills = [...forgeSkills, ...packSkills];
    const result = {
      data: { command: "forge.skill.list", skills, count: skills.length },
      exitCode: 0,
      summary: `forge.skill.list: ${skills.length} skill(s) registered (${forgeSkills.length} forge + ${packSkills.length} pack)`,
    };
    if (context.outputFormat === "pretty") {
      context.logger.section(`Forge Skills (${skills.length})`);
      for (const skill of forgeSkills) {
        context.logger.info(
          `${skill.name} [${skill.category}] — ${skill.invocation}/${skill.concerns}`,
        );
      }
      for (const skill of packSkills) {
        context.logger.info(`${skill.name} [pack:${skill.pack}]`);
      }
    }
    return result;
  };

  const doctorWrapper = async (
    input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<ForgeCommandResult> => {
    const result = await runDoctor(input, context);
    const allPass = result.data?.allPass === true;
    const hasFails = (result.data?.checks ?? []).some((c) => c.status === "fail");
    const nextSteps: ForgeNextStep[] = allPass
      ? []
      : hasFails
        ? [{ action: "Fix the violations above and re-run forge.doctor", kind: "required" }]
        : [{ action: "Review the warnings above — no action required", kind: "optional" }];
    return { ...result, nextSteps };
  };

  const createWrapper = async (
    input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<ForgeCommandResult> => {
    return runCreate(input, context);
  };

  const { runInit } = await import("../../src/onboarding/init.ts");
  const initWrapper = async (
    input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<ForgeCommandResult> => {
    const result = runInit(
      {
        flags: input.flags as {
          aiLanguage?: string;
          documentationLanguage?: string;
          from?: string;
        },
      },
      context,
    );
    return {
      data: result,
      exitCode: result.status === "pass" ? 0 : 1,
      summary:
        result.status === "pass"
          ? `[forge.init] OK — ${result.created.length} created, ${result.skipped.length} skipped`
          : undefined,
    };
  };

  const profileValidateWrapper = async (
    input: ForgeCommandInput,
    context: ForgeRuntimeContext,
  ): Promise<ForgeCommandResult> => {
    const result = await runProfileValidate(input, context);
    const nextSteps: ForgeNextStep[] =
      result.data?.valid === true
        ? []
        : [{ action: "Fix the profile validation errors above", kind: "required" }];
    return { ...result, nextSteps };
  };

  const { runDeterminismCheck } = await import("./handlers/determinism-check.ts");

  return {
    name: "forge-core",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "forge.doctor",
        mutatesState: true,
        writes: [".agents/memory/**"],
        generates: [],
        description: "Diagnose forge state in an existing project.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          strict: {
            kind: "boolean",
            description: "Elevate domain invariant warnings to errors (RFC-0640).",
          },
          fix: {
            kind: "boolean",
            description: "Apply safe remediations for warn/fail checks (RFC-1151).",
          },
        },
        cacheable: false,
        execute: doctorWrapper,
      },
      {
        name: "forge.port.scaffold",
        coverage: "operator" as const,
        mutatesState: true,
        writes: ["packages/forge/skills/**", "packages/forge/os/**"],
        generates: [],
        description: "Generate a skeleton for a new forge skill or command.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          name: { kind: "string", description: "Skill or command name (kebab-case)." },
          type: { kind: "string", description: "Type: 'skill' or 'command' (default: skill)." },
        },
        cacheable: false,
        execute: scaffoldWrapper,
      },
      {
        name: "forge.skill.validate",
        mutatesState: false,
        contract: "forge",
        rules: [],
        description:
          "Validate all forge skills against frontmatter contract and invariants SKILL-01..SKILL-20.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {},
        reads: ["packages/forge/src/**/*.ts", "packages/forge/os/**/*.ts"],
        execute: skillValidateWrapper,
      },
      {
        name: "forge.skill.list",
        coverage: "operator" as const,
        mutatesState: false,
        description: "List all registered forge skills.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {},
        reads: ["packages/forge/src/registry.ts"],
        execute: skillListWrapper,
      },
      {
        name: "forge.port.validate",
        coverage: "operator" as const,
        coverageNote: "requires --name",
        mutatesState: false,
        contract: "forge",
        rules: [],
        description:
          "Validate a single ported skill or command for compliance with forge contracts.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          name: { kind: "string", description: "Skill or command name to validate." },
        },
        reads: ["packages/forge/src/**/*.ts", "packages/forge/os/**/*.ts"],
        execute: portValidateWrapper,
      },
      {
        name: "forge.agents.generate",
        mutatesState: true,
        description:
          "Regenerate AGENTS.md deterministically from forge.yaml and the skill registry.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {},
        writes: ["AGENTS.md", "**/AGENTS.md"],
        generates: [],
        cacheable: false,
        execute: runAgentsGenerate,
      },
      {
        name: "memory.compact",
        coverage: "operator" as const,
        coverageNote: "agent memory compaction",
        mutatesState: true,
        writes: [".agents/memory/MEMORY.md"],
        generates: [],
        description:
          "Enforce the MEMORY.md character budget by removing oldest Environment notes bullets (RFC-1151).",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {},
        cacheable: false,
        execute: runMemoryCompact,
      },
      {
        name: "forge.upgrade",
        mutatesState: true,
        description:
          "Additive sync for npm consumers: refresh .agents/skills/ from installed forge, add missing binding defaults, update forge.syncedVersion, run doctor.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Preview what would change without writing files.",
          },
          "update-npm": {
            kind: "boolean",
            description:
              "Update @warpgogol/forge from npm before syncing. Skipped in monorepo (local package).",
          },
          "compass-docs": {
            kind: "boolean",
            description:
              "After syncing, run compass.docs.scaffold to materialize/merge the Compass corpus (RFC-1253).",
          },
        },
        writes: [".agents/skills/**", "forge.yaml", "docs/*.xml"],
        generates: [{ path: "docs/*.xml", phase: "on-demand", conditional: true }],
        reads: ["forge.yaml", "packages/forge/skills/**", "packages/forge/package.json"],
        cacheable: false,
        execute: async (input, context) =>
          maybeScaffoldCompassDocs(input, context, await runUpgrade(input, context)),
      },
      {
        name: "forge.scaffold",
        coverage: "operator" as const,
        mutatesState: true,
        writes: ["**"],
        generates: [],
        execOnReadOnly: true,
        description:
          "Create a working pnpm + Turborepo monorepo from a stack profile in an empty directory. Required flags: `--profile`, `--name`.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          profile: {
            kind: "string",
            required: true,
            description: "Stack profile id (e.g. phaser-game).",
          },
          name: { kind: "string", required: true, description: "Project name (kebab-case)." },
          template: {
            kind: "string",
            required: false,
            description: "Template id for multi-template profiles (e.g. react, html).",
          },
        },
        cacheable: false,
        execute: runScaffoldProject,
      },
      {
        name: "forge.create",
        mutatesState: true,
        writes: ["**"],
        generates: [],
        execOnReadOnly: true,
        description:
          "Create a forge project in-place: scaffold + init + binding defaults. The target directory must be empty (only .git/ tolerated). Usage: forge create --in-place --profile <profile-id> [--name <name>] [--package-manager pnpm]",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "in-place": {
            kind: "boolean",
            required: true,
            description: "Scaffold in the current directory (no subdirectory). Required.",
          },
          profile: {
            kind: "string",
            required: true,
            description:
              "Stack profile id. Required. Available: forge-shell, phaser-game, godot-game, knowledge, system, typescript.",
          },
          name: {
            kind: "string",
            required: false,
            description: "Project name override. If omitted, derived from the current folder name.",
          },
          "package-manager": {
            kind: "string",
            description: "Package manager to write into forge.yaml (default: pnpm).",
          },
          template: {
            kind: "string",
            description: "Template id for multi-template profiles (e.g. react, html).",
          },
          "compass-docs": {
            kind: "boolean",
            description:
              "After create, run compass.docs.scaffold to materialize the Compass corpus (RFC-1253).",
          },
          "no-flow": {
            kind: "boolean",
            description:
              "Skip the scaffold commit and flow.install adoption — the repository is created unadopted (RFC-1500).",
          },
        },
        cacheable: false,
        execute: async (input, context) =>
          maybeScaffoldCompassDocs(input, context, await createWrapper(input, context)),
      },
      {
        name: "forge.init",
        mutatesState: true,
        writes: ["forge.yaml", "PREFERENCES.md", ".agents/skills/**"],
        generates: [],
        description:
          "Deploy forge into a project: create forge.yaml, PREFERENCES.md, copy skills, create docs dirs. Hidden recovery command — normally called by forge.create.",
        scope: "workspace",
        acceptsAllFlag: false,
        hidden: true,
        flags: {
          "ai-language": {
            kind: "string",
            description: "AI communication language (default: en).",
          },
          "documentation-language": {
            kind: "string",
            description: "Documentation language (default: en).",
          },
          from: { kind: "string", description: "Detect stack from existing project path." },
          "compass-docs": {
            kind: "boolean",
            description:
              "After init, run compass.docs.scaffold to materialize the Compass corpus (RFC-1253).",
          },
        },
        cacheable: false,
        execute: async (input, context) =>
          maybeScaffoldCompassDocs(input, context, await initWrapper(input, context)),
      },
      {
        name: "forge.profile.validate",
        mutatesState: false,
        contract: "forge",
        rules: [],
        description:
          "Validate profile YAML files under packages/forge/profiles/ against the stack-profile schema (RFC-0640).",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          id: {
            kind: "string",
            description: "Validate only the profile with this id.",
          },
        },
        reads: ["packages/forge/profiles/*.yaml"],
        cacheable: false,
        execute: profileValidateWrapper,
      },
      {
        name: "forge.dev",
        coverage: "operator" as const,
        mutatesState: false,
        execOnReadOnly: true,
        description:
          "Start the dev/preview server declared in the active stack profile. Use --dry-run to print the resolved command without executing.",
        scope: "workspace",
        acceptsAllFlag: false,
        longRunning: true,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Print the resolved dev server command without executing.",
          },
          profile: {
            kind: "string",
            description: "Override the active profile id.",
          },
        },
        reads: ["forge.yaml", "packages/forge/profiles/*.yaml"],
        cacheable: false,
        execute: runDev,
      },
      {
        name: "forge.build",
        coverage: "operator" as const,
        mutatesState: false,
        execOnReadOnly: true,
        description:
          "Execute produce commands for all artifacts declared in the active stack profile. Use --dry-run to print resolved commands.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Print resolved produce commands without executing.",
          },
          profile: {
            kind: "string",
            description: "Override the active profile id.",
          },
        },
        reads: ["forge.yaml", "packages/forge/profiles/*.yaml"],
        cacheable: false,
        execute: runBuild,
      },
      {
        name: "forge.validate",
        mutatesState: false,
        contract: "forge",
        rules: [],
        description:
          "Execute validate commands for all artifacts declared in the active stack profile. Use --dry-run to print resolved commands. Use --artifact to validate a single artifact.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Print resolved validate commands without executing.",
          },
          profile: {
            kind: "string",
            description: "Override the active profile id.",
          },
          artifact: {
            kind: "string",
            description: "Validate only the specified artifact id.",
          },
        },
        reads: ["forge.yaml", "packages/forge/profiles/*.yaml"],
        cacheable: false,
        execute: runValidate,
      },
      {
        name: "forge.determinism.check",
        coverage: "operator" as const,
        coverageNote: "forge determinism audit",
        mutatesState: true,
        contract: "forge",
        rules: [],
        description:
          "Verify artifact determinism by building twice and comparing output hashes. Reads determinism.inputs glob patterns from the active stack profile. Use --dry-run to print resolved inputs, --artifact to check a single artifact.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Print resolved determinism inputs without executing builds.",
          },
          profile: {
            kind: "string",
            description: "Override the active profile id.",
          },
          artifact: {
            kind: "string",
            description: "Check only the specified artifact id.",
          },
        },
        reads: ["forge.yaml", "packages/forge/profiles/*.yaml", "dist/.determinism-cache.json"], // scan-coverage: post-build artifact — dist/ exists only after forge build
        writes: ["dist/.determinism-cache.json"], // scan-coverage: post-build artifact — dist/ exists only after forge build
        generates: [],
        cacheable: false,
        execute: runDeterminismCheck,
      },
      {
        name: "forge.assets.list",
        coverage: "operator" as const,
        coverageNote: "asset listing for asset-declaring forge profiles",
        mutatesState: false,
        description:
          "List all assets declared in the active stack profile, grouped by type. Use --dry-run to skip hashing, --type to filter by asset type.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "List assets without computing hashes.",
          },
          profile: {
            kind: "string",
            description: "Override the active profile id.",
          },
          type: {
            kind: "string",
            description: "Filter assets by type id (e.g. video, audio, image).",
          },
        },
        reads: ["forge.yaml", "packages/forge/profiles/*.yaml", "assets/**"], // scan-coverage: consumer-workshop root — assets/ declared by stack profiles
        cacheable: false,
        execute: runAssetsList,
      },
      {
        name: "forge.assets.check",
        coverage: "operator" as const,
        coverageNote: "asset check for asset-declaring forge profiles",
        mutatesState: false,
        contract: "forge",
        rules: [],
        description:
          "Check for missing, orphaned, and unreferenced assets. Use --strict to fail on orphaned assets, --dry-run to skip hashing.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Check file existence without computing hashes.",
          },
          strict: {
            kind: "boolean",
            description: "Exit non-zero when orphaned assets are found.",
          },
          profile: {
            kind: "string",
            description: "Override the active profile id.",
          },
        },
        reads: ["forge.yaml", "packages/forge/profiles/*.yaml", "assets/**"], // scan-coverage: consumer-workshop root — assets/ declared by stack profiles
        cacheable: false,
        execute: runAssetsCheck,
      },
      {
        name: "forge.release.prepare",
        coverage: "operator" as const,
        coverageNote: "forge release front door",
        mutatesState: true,
        description:
          "Bundle built artifacts into a release package with a manifest. Use --dry-run to preview without writing.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Print the resolved release steps without executing.",
          },
          profile: {
            kind: "string",
            description: "Override the active profile id.",
          },
        },
        reads: ["forge.yaml", "packages/forge/profiles/*.yaml", "dist/**"],
        writes: ["release/**"],
        generates: [],
        cacheable: false,
        execute: runReleasePrepare,
      },
      {
        envInputs: [
          { name: "R2_AXIOM_ACCESS_KEY_ID", required: false },
          { name: "R2_AXIOM_ACCOUNT_ID", required: false },
          { name: "R2_AXIOM_SECRET_ACCESS_KEY", required: false },
          { name: "S3_ACCESS_KEY_ID", required: false },
          { name: "S3_BUCKET", required: false },
          { name: "S3_ENDPOINT", required: false },
          { name: "S3_SECRET_ACCESS_KEY", required: false },
        ],
        name: "forge.release.publish",
        coverage: "operator" as const,
        coverageNote: "forge release publish step",
        mutatesState: true,
        description:
          "Publish a prepared release to the declared target (local, R2, S3). Use --dry-run to preview without uploading.",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Print the resolved publish target and file list without uploading.",
          },
          profile: {
            kind: "string",
            description: "Override the active profile id.",
          },
        },
        reads: ["forge.yaml", "packages/forge/profiles/*.yaml", "release/**"],
        writes: ["release/published/**"],
        generates: [],
        cacheable: false,
        execute: runReleasePublish,
      },
      {
        name: "forge.skill.knowledge.compact",
        coverage: "operator" as const,
        mutatesState: true,
        description:
          "Compact skill knowledge files: archive expired/superseded/aged L0 entries, mark stale L2 principles. " +
          "Usage: forge.skill.knowledge.compact --all-skills [--dry-run] [--json] | --skill <name> [--dry-run] [--json]",
        scope: "workspace",
        acceptsAllFlag: false,
        flags: {
          skill: {
            kind: "string",
            description:
              "Compact a single skill's declared knowledge files. Mutually exclusive with --all-skills.",
          },
          "all-skills": {
            kind: "boolean",
            description:
              "Compact all forge and pack skills declaring knowledge: files. (Named --all-skills because the CLI reserves --all.)",
          },
          "dry-run": {
            kind: "boolean",
            description: "Report planned mutations; write nothing.",
          },
          json: {
            kind: "boolean",
            description: "Machine-readable report.",
          },
          "retention-days": {
            kind: "string",
            description: "L0 entries older than this many days are archived (default: 90).",
          },
          "stale-days": {
            kind: "string",
            description:
              "L2 entries with lastConfirmedAt older than this become stale (default: 90).",
          },
        },
        writes: ["packages/forge/skills/**/*.md", "packages/forge/skills/**/*.archive.md"],
        generates: [],
        reads: [
          "packages/forge/skills/**/*.md",
          "packages/forge/skills/**/*.archive.md",
          "forge.yaml",
        ],
        cacheable: false,
        execute: runKnowledgeCompact,
      },
      {
        envInputs: [{ name: "FORGE_PINNED_OVERRIDE", required: false }],
        name: "pinned.validate",
        coverage: "operator" as const,
        coverageNote: "pin-file hygiene",
        mutatesState: true,
        contract: "pinned",
        rules: [],
        description:
          "Validate working tree against .forge/pinned.yaml manifest. " +
          "Checks staged changes (default) or last commit (--mode ci) for " +
          "delete/move/modify operations on pinned files. " +
          "Use --allow-pinned-override <path> for audited escape hatch.",
        scope: "workspace",
        reads: [".forge/pinned.yaml", ".forge/pinned-audit.log"],
        writes: [".forge/pinned-audit.log"],
        generates: [],
        cacheable: false,
        flags: {
          "allow-pinned-override": {
            kind: "string[]",
            description:
              "Path(s) to exempt from pinned-files validation on this invocation. " +
              "Each override is logged to .forge/pinned-audit.log.",
          },
          mode: {
            kind: "string",
            description:
              "Validation mode: 'staged' (pre-commit, default) or 'ci' (last-commit diff).",
          },
          json: {
            kind: "boolean",
            description: "Output structured JSON result.",
          },
        },
        execute: runPinnedValidate,
      },
      {
        name: "pinned.init",
        coverage: "operator" as const,
        coverageNote: "pin-file bootstrap for mission pinning",
        description:
          "Initialize .forge/pinned.yaml with default foundation entries, " +
          "install pre-commit hook, and add audit log to .gitignore. " +
          "Use --ci to also generate .github/workflows/pinned-check.yml.",
        scope: "workspace",
        mutatesState: true,
        writes: [
          ".forge/pinned.yaml",
          ".git/hooks/pre-commit",
          ".gitignore",
          ".github/workflows/pinned-check.yml",
        ],
        generates: [],
        reads: [".forge/pinned.yaml", ".git/hooks/pre-commit", ".gitignore"],
        cacheable: false,
        flags: {
          ci: {
            kind: "boolean",
            description: "Also generate .github/workflows/pinned-check.yml CI workflow.",
          },
        },
        execute: runPinnedInit,
      },
      {
        name: "forge.package.health",
        mutatesState: false,
        description:
          "Validate all published packages (private: false) for standalone extraction readiness. " +
          "Checks engines.node, embedded .github/workflows/ci.yml, extract.config.yaml, " +
          "devDependencies completeness (no hoisted tool deps), per-package lint-surface " +
          "(extractable packages run their own lint contract), and PKG-HEALTH-10 " +
          "fixture-path scan — shipped ../ literals must resolve inside the package " +
          'root (same-line "// pkg-health-10:" or pkgHealth10Suppressions in ' +
          "extract.config.yaml), and the RFC-1518 docs-drift gate: PKG-HEALTH-11 " +
          "(registered command absent from the package DOCS_SURFACE) and " +
          "PKG-HEALTH-12 (dead x.y doc tokens) — same-line " +
          '"<!-- pkg-health-11|pkg-health-12: <reason> -->" markers journal ' +
          "intentional exceptions. " +
          "Exits non-zero on errors. Use --json for machine-readable output.",
        scope: "workspace",
        acceptsAllFlag: false,
        reads: [
          "packages/*/package.json",
          "packages/*/.github/workflows/ci.yml",
          "packages/*/extract.config.yaml",
        ],
        cacheable: false,
        flags: {
          json: {
            kind: "boolean",
            description: "Output structured JSON result.",
          },
        },
        execute: runPackageHealth,
      },
      {
        name: "forge.autonomy.validate",
        mutatesState: false,
        contract: "forge",
        rules: [],
        description:
          "Scan packages/forge/os/** for forbidden @warpgogol/werkstatt-engine imports outside os/werkstatt/. " +
          "Enforces FORGE-AUTONOMY-01 (RFC-0940, DNA-64). @warpgogol/werkstatt-shared is exempt. " +
          "Type-only imports (import type) are exempt.",
        scope: "workspace",
        acceptsAllFlag: false,
        reads: ["packages/forge/os/**/*.ts"],
        cacheable: false,
        flags: {},
        execute: runForgeAutonomyValidate,
      },
      {
        name: "forge.public-surface.validate",
        mutatesState: false,
        description:
          "Check consistency between README.md, package.json, and docs/ structure. " +
          "Enforces SURFACE-01..05 rules: README length, Node version match, " +
          "no .tgz in root, docs/ structure, required root files (RFC-1080).",
        contract: "forge",
        rules: [
          { id: "SURFACE-01", severity: "error" },
          { id: "SURFACE-02", severity: "error" },
          { id: "SURFACE-03", severity: "error" },
          { id: "SURFACE-04", severity: "error" },
          { id: "SURFACE-05", severity: "error" },
        ],
        scope: "workspace",
        acceptsAllFlag: false,
        reads: ["README.md", "package.json", "docs/**"],
        cacheable: false,
        flags: {},
        execute: runPublicSurfaceValidate,
      },
      {
        name: "file.size.lint",
        mutatesState: true,
        contract: "file",
        rules: [{ id: "SIZE-01", severity: "error" }],
        description:
          "SIZE-01: flags a packages/** .ts/.tsx source file exceeding a 600-line threshold (warning 601-1200, error 1200+), against a shrink-only ratchet baseline. Pass --write-baseline to regenerate the baseline. Pass --baseline-path to override the default baseline location (RFC-1088).",
        scope: "workspace",
        acceptsAllFlag: false,
        reads: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
        writes: ["file-size-lint.baseline.yaml"],
        generates: [],
        cacheable: false,
        flags: {
          "write-baseline": {
            kind: "boolean",
            description: "Regenerate the oversized-file baseline instead of validating against it.",
          },
          "baseline-path": {
            kind: "string",
            description:
              "Override the baseline file path (default: file-size-lint.baseline.yaml at workspace root).",
          },
        },
        execute: runFileSizeLint,
      },
      {
        name: "docs.archive",
        coverage: "operator" as const,
        description:
          "Umbrella command that runs rfc.archive, adr.archive, plan.archive, " +
          "audit.archive, session.archive, and mission.archive in sequence. " +
          "Passes --dry-run and --status through to all sub-commands. Not atomic " +
          "— if one sub-command fails, prior moves are not rolled back. " +
          "After the moves, re-invokes the owner generator of every generated " +
          "artifact invalidated by them (manifest last) through the kernel " +
          "invoke port and reports the regenerated paths (RFC-1528). " +
          "Re-running is safe (idempotent).",
        scope: "workspace",
        mutatesState: true,
        writes: [
          "docs/rfcs/*.md",
          "docs/rfcs/archive/**",
          "docs/adrs/*.md",
          "docs/adrs/archive/**",
          "docs/plans/*.md",
          "docs/plans/archive/**",
          "docs/audits/*.md",
          "docs/audits/archive/**",
          "docs/sessions/*.md",
          "docs/sessions/archive/**",
          "missions/*",
          "missions/archive/**",
          "docs/specs/live/*.md",
          "pnpm-lock.yaml",
          // RFC-1528: owner-regen writes the generated artifacts invalidated by
          // the moves (via context.invoke — never duplicated generator logic).
          "docs/ecosystem.generated.yaml",
          "docs/rfcs/index.yaml",
        ],
        generates: [],
        reads: [
          "docs/rfcs/**/*.md",
          "docs/adrs/**/*.md",
          "docs/plans/**/*.md",
          "docs/audits/**/*.md",
          "docs/sessions/**/*.md",
          "docs/specs/live/*.md",
          "missions/**",
        ],
        cacheable: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Preview what would be moved without touching the filesystem.",
          },
          status: {
            kind: "string",
            description: "Filter to a single terminal status (implemented, rejected, superseded).",
          },
        },
        execute: async (input, context) => {
          const { logger, outputFormat } = context;
          const dryRun = context.dryRun || input.flags["dry-run"] === true;
          const results: Record<string, unknown> = {};
          let totalMoved = 0;
          let totalSkipped = 0;

          const { runRfcArchive } = await import("../rfc/handlers/archive.ts");
          const { runAdrArchive } = await import("../adr/handlers/archive.ts");
          const { runPlanArchive } = await import("../plan/handlers/archive.ts");
          const { runAuditArchive } = await import("../audit/handlers/archive.ts");
          const { runSessionArchive } = await import("../session/handlers/archive.ts");
          const { runMissionArchive } = await import("../mission/handlers/archive.ts");

          type ArchiveHandler = (
            input: ForgeCommandInput,
            context: ForgeRuntimeContext,
          ) => Promise<ForgeCommandResult>;

          const subCommands: Array<{ name: string; fn: ArchiveHandler }> = [
            { name: "rfc.archive", fn: runRfcArchive as ArchiveHandler },
            { name: "adr.archive", fn: runAdrArchive as ArchiveHandler },
            { name: "plan.archive", fn: runPlanArchive as ArchiveHandler },
            { name: "audit.archive", fn: runAuditArchive as ArchiveHandler },
            { name: "session.archive", fn: runSessionArchive as ArchiveHandler },
            { name: "mission.archive", fn: runMissionArchive as ArchiveHandler },
          ];

          for (const { name: cmdName, fn } of subCommands) {
            try {
              const result = await fn(input, context);
              const data = (result as { data?: { moved?: unknown[]; skipped?: unknown[] } })?.data;
              if (data) {
                totalMoved += Array.isArray(data.moved) ? data.moved.length : 0;
                totalSkipped += Array.isArray(data.skipped) ? data.skipped.length : 0;
              }
              results[cmdName] = data ?? result;
            } catch (err) {
              results[cmdName] = { error: String((err as Error).message) };
            }
          }

          // ── RFC-0711 + RFC-1230: post-loop spec.live.merge — only RFCs moved
          // into archive/implemented/ this run. Re-scanning the whole tree on
          // every invocation is what produced duplicate sections/history.
          // Merge failure stays non-fatal; V-LS-08 detects any coverage gap. ──
          const { readAndParseRfc } = await import("../rfc/frontmatter-io.ts");
          const { RFC_DIR } = await import("../rfc/types.ts");
          const { runSpecLiveMerge } = await import("../spec/live-spec-merge.ts");
          const {
            collectLiveMergeTargets,
            classifyLiveMergeOutcome,
            liveMergeFailureEntry,
            formatLiveMergeFailure,
            buildLiveMergeBlock,
          } = await import("../spec/live-spec-shared.ts");
          const rfcDirPath = path.join(context.workspaceRoot, RFC_DIR);
          const rfcArchiveData = results["rfc.archive"] as
            | {
                moved?: Array<{
                  id: string;
                  status: string;
                  direction: string;
                  from: string;
                  to: string;
                }>;
              }
            | undefined;
          const thisRunMoved = Array.isArray(rfcArchiveData?.moved) ? rfcArchiveData.moved : [];
          const movedById = new Map(thisRunMoved.map((m) => [m.id, m]));
          const selection = collectLiveMergeTargets(thisRunMoved);
          const liveMergeResults: Array<{
            id: string;
            domain: string;
            operation: string;
            conflicts: number;
          }> = [];
          // RFC-1235: exit-nonzero merges land in failed[] — merged[] must mean
          // "the spec was written". Thrown and exit-1-with-data paths both record.
          const liveMergeFailures: Array<{
            id: string;
            exitCode?: number;
            error: string;
          }> = [];
          let liveMergeSkipped = 0;

          const parseMovedRfc = async (id: string) => {
            const move = movedById.get(id);
            if (!move) return undefined;
            const rel = (p: string) =>
              p.startsWith(`${RFC_DIR}/`) ? p.slice(RFC_DIR.length + 1) : p;
            // Under --dry-run the file was not renamed — `to` does not exist yet,
            // so fall back to `from` (the still-current location).
            for (const candidate of [rel(move.to), rel(move.from)]) {
              const parsed = await readAndParseRfc(rfcDirPath, candidate);
              if (parsed && "parsed" in parsed) return parsed;
            }
            return undefined;
          };

          for (const rfcId of selection.rejected) {
            const parsed = await parseMovedRfc(rfcId);
            if (parsed?.parsed.frontmatter["liveSpec"]) {
              liveMergeSkipped++;
              if (outputFormat === "pretty") {
                logger.info(`  spec.live.merge: skipping ${rfcId} (status: rejected)`);
              }
            }
          }

          for (const rfcId of selection.candidates) {
            const parsed = await parseMovedRfc(rfcId);
            if (!parsed) continue;
            if (!parsed.parsed.frontmatter["liveSpec"]) continue;

            try {
              const mergeInput: ForgeCommandInput = {
                argv: [],
                flags: { id: rfcId, "dry-run": dryRun },
              };
              const mergeResult = await runSpecLiveMerge(mergeInput, context);
              const outcome = classifyLiveMergeOutcome(rfcId, mergeResult);
              if (outcome.kind === "merged") {
                liveMergeResults.push(outcome.entry);
              } else {
                liveMergeFailures.push(outcome.entry);
                if (outputFormat === "pretty") {
                  logger.error(`  ${formatLiveMergeFailure(outcome.entry)}`);
                }
              }
            } catch (err) {
              const failure = liveMergeFailureEntry(rfcId, err);
              liveMergeFailures.push(failure);
              if (outputFormat === "pretty") {
                logger.error(`  ${formatLiveMergeFailure(failure)}`);
              }
            }
          }

          const liveMergeBlock = buildLiveMergeBlock(
            liveMergeResults,
            liveMergeFailures,
            liveMergeSkipped,
            dryRun,
          );
          if (liveMergeBlock) {
            results["spec.live.merge"] = liveMergeBlock;
            if (outputFormat === "pretty") {
              for (const r of liveMergeResults) {
                logger.info(
                  `  spec.live.merge: ${r.id} → ${r.domain} (${r.operation})${r.conflicts > 0 ? ` [${r.conflicts} conflicts]` : ""}${dryRun ? " [dry-run]" : ""}`,
                );
              }
            }
          }

          // RFC-1505: post-loop lockfile restore — safety net for mission.archive's
          // own restore. Only mission moves run `pnpm install` and can churn the
          // lockfile; gating on them alone means an rfc/adr/plan-only archive run
          // never touches a locally edited pnpm-lock.yaml. Restore HEAD bytes
          // instead of staging — mission churn is never committed.
          const missionData = results["mission.archive"] as { moved?: unknown[] } | undefined;
          const missionMoved = Array.isArray(missionData?.moved) ? missionData.moved.length : 0;
          if (!dryRun && missionMoved > 0) {
            try {
              const restored = await restoreTrackedLockfile(context.workspaceRoot, {
                ...execFileSyncAdapter(),
                writeFile: async (target, content) => {
                  await writeFileIfChanged(target, content);
                },
              });
              if (restored && outputFormat === "pretty") {
                logger.info("  docs.archive: restored pnpm-lock.yaml to HEAD (safety net)");
              }
            } catch (refreshErr) {
              if (outputFormat === "pretty") {
                logger.warn(
                  `  docs.archive: lockfile safety-net restore failed — run 'pnpm install' manually: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`,
                );
              }
            }
          }

          // ── RFC-1528: owner-regen — every generated artifact whose owner
          // reads a moved path is re-invoked through context.invoke (AC-1/6/7).
          // Runs after the lockfile safety net; absent invoke degrades with a
          // note, never blocks. Owner failure → diagnostics + non-zero exit. ──
          let regenerated: string[] = [];
          let regenSkipped: string[] = [];
          let regenFailures: Array<{ command: string; error: string }> = [];
          const { shouldRunArchiveRegen, runArchiveRegen } = await import("./archive-regen.ts");
          if (shouldRunArchiveRegen(dryRun, totalMoved)) {
            const movedPaths = new Set<string>();
            for (const data of Object.values(results)) {
              // An archiver that threw records `{error}` with no moved[] — the
              // regen set under-counts its partial moves (pre-existing shape).
              const moved = (data as { moved?: Array<Record<string, unknown>> })?.moved;
              if (!Array.isArray(moved)) continue;
              for (const entry of moved) {
                for (const key of ["from", "to", "file"] as const) {
                  const value = entry[key];
                  if (typeof value === "string" && value.length > 0) movedPaths.add(value);
                }
              }
            }
            const regen = await runArchiveRegen({ movedPaths: [...movedPaths], context });
            regenerated = regen.regenerated;
            regenFailures = regen.failures;
            regenSkipped = regen.skipped;
            if (outputFormat === "pretty") {
              for (const regeneratedPath of regenerated) {
                logger.info(`  docs.archive: regenerated ${regeneratedPath}`);
              }
              if (regen.skipReason === "no-invoke") {
                logger.info("  docs.archive: regen skipped — no invoke port (standalone CLI)");
              } else if (regen.skipReason === "no-inventory") {
                logger.info("  docs.archive: regen skipped — no command inventory");
              }
              for (const failure of regenFailures) {
                logger.error(
                  `  docs.archive: regen failed for ${failure.command}: ${failure.error}`,
                );
              }
            }
          }

          if (outputFormat === "pretty") {
            if (dryRun) {
              logger.info(
                `[dry-run] docs.archive: would move ${totalMoved} file(s), skip ${totalSkipped} across all domains`,
              );
            } else {
              logger.success(
                `docs.archive: moved ${totalMoved} file(s), skipped ${totalSkipped} across all domains`,
              );
            }
          }

          return {
            ...(regenFailures.length > 0 ? { exitCode: 1 } : {}),
            data: {
              command: "docs.archive",
              status: regenFailures.length > 0 ? "fail" : "ok",
              totalMoved,
              totalSkipped,
              results,
              dryRun,
              liveSpecMerges: liveMergeResults.length,
              liveSpecSkipped: liveMergeSkipped,
              liveSpecFailures: liveMergeFailures.length,
              regenerated,
              regenSkipped,
              regenFailures,
            },
            summary: dryRun
              ? `[dry-run] Would move ${totalMoved} file(s), skip ${totalSkipped}`
              : `Moved ${totalMoved} file(s), skipped ${totalSkipped}`,
          };
        },
      },
    ],
    pipelines: [],
  };
}
