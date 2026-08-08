/*
<MODULE_CONTRACT>
<purpose>Register the core forge onboarding, scaffold, and validation commands with the kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to src/ handlers.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forgeCoreModule registering 4 forge commands.</item>
  <item>RFC-0521: register docs.archive umbrella command dispatching to rfc/adr/plan/audit archive commands.</item>
  <item>RFC-0539: extended forge.skill.list to include pack skills with pack column.</item>
  <item>RFC-0542: populate nextSteps in forge.init, forge.scaffold, forge.doctor, forge.port.scaffold results.</item>
  <item>RFC-0543: register forge.upgrade command for additive consumer sync.</item>
  <item>RFC-0544: register forge.create command composing scaffold + init.</item>
  <item>RFC-0544 fix: simplify createWrapper — runCreate already populates nextSteps.</item>
  <item>RFC-0546: remove forge.init CLI registration; runInit() remains as internal primitive called by forge.create.</item>
  <item>RFC-0640: register forge.profile.validate command, add --strict flag to forge.doctor.</item>
  <item>RFC-0662: register forge.skill.knowledge.compact command for skill knowledge lifecycle compaction.</item>
  <item>RFC-0674: register forge.dev, forge.build, forge.validate lifecycle commands.</item>
  <item>RFC-0678: register forge.determinism.check lifecycle command.</item>
  <item>RFC-0679: register forge.assets.list, forge.assets.check commands.</item>
  <item>RFC-0680: register forge.release.prepare, forge.release.publish commands.</item>
  <item>ADR-0021: profile-driven video lifecycle — all lifecycle commands read behavior from profile YAML, zero domain-specific code in Forge source.</item>
  <item>RFC-0711: docs.archive post-loop step calls spec.live.merge for implemented RFCs with liveSpec field; skips rejected RFCs.</item>
  <item>RFC-0733: register forge pinned.validate and forge pinned.init commands for pinned-files protection system.</item>
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
import {
  FORGE_SKILLS,
  discoverPackSkills,
  type ForgeSkillEntry,
  type PackSkillEntry,
} from "../../src/registry.ts";
import { loadForgeConfig } from "../../src/config/forge-config.ts";

export const forgeCoreModule: ForgeModule = {
  name: "forge-core",
  version: "0.1.0",
  async register(registry) {
    const { runScaffold } = await import("../../src/onboarding/scaffold.ts");
    const { runSkillValidate } = await import("../../src/validators/skill-validate.ts");
    const { runPortValidate } = await import("../../src/validators/port-validate.ts");
    const { runDoctor } = await import("../../src/onboarding/doctor.ts");
    const { runAgentsGenerate } = await import("../../src/onboarding/agents-generate.ts");
    const { runScaffoldProject } = await import("../../src/onboarding/scaffold-project.ts");
    const { runUpgrade } = await import("../../src/onboarding/upgrade.ts");
    const { runCreate } = await import("../../src/onboarding/create.ts");
    const { runProfileValidate } = await import("../../src/onboarding/profile-validate.ts");
    const { runDev } = await import("./handlers/dev.ts");
    const { runBuild } = await import("./handlers/build.ts");
    const { runValidate } = await import("./handlers/validate.ts");
    const { runPinnedValidate } = await import("./handlers/pinned-validate.ts");
    const { runPinnedInit } = await import("./handlers/pinned-init.ts");

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
      const nextSteps: ForgeNextStep[] = allPass
        ? []
        : [{ action: "Fix the violations above and re-run forge.doctor", kind: "required" }];
      return { ...result, nextSteps };
    };

    registry.registerCommand({
      name: "forge.doctor",
      description: "Diagnose forge state in an existing project.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        strict: {
          kind: "boolean",
          description: "Elevate domain invariant warnings to errors (RFC-0640).",
        },
      },
      cacheable: false,
      execute: doctorWrapper,
    });
    registry.registerCommand({
      name: "forge.port.scaffold",
      description: "Generate a skeleton for a new forge skill or command.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        name: { kind: "string", description: "Skill or command name (kebab-case)." },
        type: { kind: "string", description: "Type: 'skill' or 'command' (default: skill)." },
      },
      cacheable: false,
      execute: scaffoldWrapper,
    });
    registry.registerCommand({
      name: "forge.skill.validate",
      description:
        "Validate all forge skills against frontmatter contract and invariants SKILL-01..SKILL-20.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      reads: ["packages/forge/src/**/*.ts", "packages/forge/os/**/*.ts"],
      execute: skillValidateWrapper,
    });
    registry.registerCommand({
      name: "forge.skill.list",
      description: "List all registered forge skills.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      reads: ["packages/forge/src/registry.ts"],
      execute: skillListWrapper,
    });
    registry.registerCommand({
      name: "forge.port.validate",
      description: "Validate a single ported skill or command for compliance with forge contracts.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        name: { kind: "string", description: "Skill or command name to validate." },
      },
      reads: ["packages/forge/src/**/*.ts", "packages/forge/os/**/*.ts"],
      execute: portValidateWrapper,
    });
    registry.registerCommand({
      name: "forge.agents.generate",
      description: "Regenerate AGENTS.md deterministically from forge.yaml and the skill registry.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {},
      cacheable: false,
      execute: runAgentsGenerate,
    });
    // ── forge.upgrade ───────────────────────────────────────────────────────
    registry.registerCommand({
      name: "forge.upgrade",
      description:
        "Additive sync for npm consumers: refresh .agents/skills/ from installed forge, add missing binding defaults, update forge.syncedVersion, run doctor.",
      scope: "workspace",
      supportsAllSites: false,
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
      },
      writes: [".agents/skills/**", "forge.yaml"],
      reads: ["forge.yaml", "packages/forge/skills/**", "packages/forge/package.json"],
      cacheable: false,
      execute: runUpgrade,
    });
    registry.registerCommand({
      name: "forge.scaffold",
      description:
        "Create a working pnpm + Turborepo monorepo from a stack profile in an empty directory.",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        profile: {
          kind: "string",
          required: true,
          description: "Stack profile id (e.g. astro-typescript-turborepo).",
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
    });

    // ── forge.create ─────────────────────────────────────────────────────────
    const createWrapper = async (
      input: ForgeCommandInput,
      context: ForgeRuntimeContext,
    ): Promise<ForgeCommandResult> => {
      return runCreate(input, context);
    };
    registry.registerCommand({
      name: "forge.create",
      description:
        "Create a new forge project in one command: scaffold + init + binding defaults. Usage: forge create --name <name> [--profile forge-shell] [--package-manager pnpm]",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        name: {
          kind: "string",
          required: true,
          description: "Project name.",
        },
        profile: {
          kind: "string",
          description: "Stack profile id (default: forge-shell).",
        },
        "package-manager": {
          kind: "string",
          description: "Package manager to write into forge.yaml (default: pnpm).",
        },
        template: {
          kind: "string",
          description: "Template id for multi-template profiles (e.g. react, html).",
        },
      },
      cacheable: false,
      execute: createWrapper,
    });

    // ── forge.profile.validate (RFC-0640) ────────────────────────────────────
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
    registry.registerCommand({
      name: "forge.profile.validate",
      description:
        "Validate profile YAML files under packages/forge/profiles/ against the stack-profile schema (RFC-0640).",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        id: {
          kind: "string",
          description: "Validate only the profile with this id.",
        },
      },
      reads: ["packages/forge/profiles/*.yaml"],
      cacheable: false,
      execute: profileValidateWrapper,
    });

    // ── forge.dev (RFC-0674) ──────────────────────────────────────────────────
    registry.registerCommand({
      name: "forge.dev",
      description:
        "Start the dev/preview server declared in the active stack profile. Use --dry-run to print the resolved command without executing.",
      scope: "workspace",
      supportsAllSites: false,
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
    });

    // ── forge.build (RFC-0674) ────────────────────────────────────────────────
    registry.registerCommand({
      name: "forge.build",
      description:
        "Execute produce commands for all artifacts declared in the active stack profile. Use --dry-run to print resolved commands.",
      scope: "workspace",
      supportsAllSites: false,
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
    });

    // ── forge.validate (RFC-0674, RFC-0677) ───────────────────────────────────
    registry.registerCommand({
      name: "forge.validate",
      description:
        "Execute validate commands for all artifacts declared in the active stack profile. Use --dry-run to print resolved commands. Use --artifact to validate a single artifact.",
      scope: "workspace",
      supportsAllSites: false,
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
    });

    // ── forge.determinism.check (RFC-0678) ─────────────────────────────────────
    const { runDeterminismCheck } = await import("./handlers/determinism-check.ts");
    registry.registerCommand({
      name: "forge.determinism.check",
      description:
        "Verify artifact determinism by building twice and comparing output hashes. Reads determinism.inputs glob patterns from the active stack profile. Use --dry-run to print resolved inputs, --artifact to check a single artifact.",
      scope: "workspace",
      supportsAllSites: false,
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
      reads: ["forge.yaml", "packages/forge/profiles/*.yaml", "dist/.determinism-cache.json"],
      writes: ["dist/.determinism-cache.json"],
      cacheable: false,
      execute: runDeterminismCheck,
    });

    // ── forge.assets.list (RFC-0679) ───────────────────────────────────────────
    const { runAssetsList } = await import("./handlers/assets-list.ts");
    registry.registerCommand({
      name: "forge.assets.list",
      description:
        "List all assets declared in the active stack profile, grouped by type. Use --dry-run to skip hashing, --type to filter by asset type.",
      scope: "workspace",
      supportsAllSites: false,
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
      reads: ["forge.yaml", "packages/forge/profiles/*.yaml", "assets/**"],
      cacheable: false,
      execute: runAssetsList,
    });

    // ── forge.assets.check (RFC-0679) ──────────────────────────────────────────
    const { runAssetsCheck } = await import("./handlers/assets-check.ts");
    registry.registerCommand({
      name: "forge.assets.check",
      description:
        "Check for missing, orphaned, and unreferenced assets. Use --strict to fail on orphaned assets, --dry-run to skip hashing.",
      scope: "workspace",
      supportsAllSites: false,
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
      reads: ["forge.yaml", "packages/forge/profiles/*.yaml", "assets/**"],
      cacheable: false,
      execute: runAssetsCheck,
    });

    // ── forge.release.prepare (RFC-0680) ────────────────────────────────────────
    const { runReleasePrepare } = await import("./handlers/release-prepare.ts");
    registry.registerCommand({
      name: "forge.release.prepare",
      description:
        "Bundle built artifacts into a release package with a manifest. Use --dry-run to preview without writing.",
      scope: "workspace",
      supportsAllSites: false,
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
      cacheable: false,
      execute: runReleasePrepare,
    });

    // ── forge.release.publish (RFC-0680) ───────────────────────────────────────
    const { runReleasePublish } = await import("./handlers/release-publish.ts");
    registry.registerCommand({
      name: "forge.release.publish",
      description:
        "Publish a prepared release to the declared target (local, R2, S3). Use --dry-run to preview without uploading.",
      scope: "workspace",
      supportsAllSites: false,
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
      cacheable: false,
      execute: runReleasePublish,
    });

    // ── forge.skill.knowledge.compact (RFC-0662) ──────────────────────────────
    const { runKnowledgeCompact } = await import("./handlers/knowledge-compact.ts");
    registry.registerCommand({
      name: "forge.skill.knowledge.compact",
      description:
        "Compact skill knowledge files: archive expired/superseded/aged L0 entries, mark stale L2 principles. " +
        "Usage: forge.skill.knowledge.compact --all-skills [--dry-run] [--json] | --skill <name> [--dry-run] [--json]",
      scope: "workspace",
      supportsAllSites: false,
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
      reads: [
        "packages/forge/skills/**/*.md",
        "packages/forge/skills/**/*.archive.md",
        "forge.yaml",
      ],
      cacheable: false,
      execute: runKnowledgeCompact,
    });

    // ── pinned.validate ─────────────────────────────────────────────────────
    registry.registerCommand({
      name: "pinned.validate",
      description:
        "Validate working tree against .forge/pinned.yaml manifest. " +
        "Checks staged changes (default) or last commit (--mode ci) for " +
        "delete/move/modify operations on pinned files. " +
        "Use --allow-pinned-override <path> for audited escape hatch.",
      scope: "workspace",
      reads: [".forge/pinned.yaml", ".forge/pinned-audit.log"],
      writes: [".forge/pinned-audit.log"],
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
    });

    // ── pinned.init ─────────────────────────────────────────────────────────
    registry.registerCommand({
      name: "pinned.init",
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
      reads: [".forge/pinned.yaml", ".git/hooks/pre-commit", ".gitignore"],
      cacheable: false,
      flags: {
        ci: {
          kind: "boolean",
          description: "Also generate .github/workflows/pinned-check.yml CI workflow.",
        },
      },
      execute: runPinnedInit,
    });

    // ── docs.archive ─────────────────────────────────────────────────────────
    registry.registerCommand({
      name: "docs.archive",
      description:
        "Umbrella command that runs rfc.archive, adr.archive, plan.archive, " +
        "audit.archive, session.archive, and mission.archive in sequence. " +
        "Passes --dry-run and --status through to all sub-commands. Not atomic " +
        "— if one sub-command fails, prior moves are not rolled back. " +
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
      ],
      reads: [
        "docs/rfcs/**/*.md",
        "docs/adrs/**/*.md",
        "docs/plans/**/*.md",
        "docs/audits/**/*.md",
        "docs/sessions/**/*.md",
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

        // ── RFC-0711: post-loop spec.live.merge for implemented RFCs with liveSpec ──
        const { listRfcFiles, readAndParseRfc } = await import("../rfc/frontmatter-io.ts");
        const { RFC_DIR } = await import("../rfc/types.ts");
        const { runSpecLiveMerge } = await import("../spec/live-spec-merge.ts");
        const rfcDirPath = path.join(context.workspaceRoot, RFC_DIR);
        const statusFilter = input.flags["status"] as string | undefined;
        const allRfcFiles = await listRfcFiles(rfcDirPath);
        const liveMergeResults: Array<{
          id: string;
          domain: string;
          operation: string;
          conflicts: number;
        }> = [];
        let liveMergeSkipped = 0;

        for (const rfcFile of allRfcFiles) {
          const parsed = await readAndParseRfc(rfcDirPath, rfcFile);
          if (!parsed || "error" in parsed) continue;
          const fm = parsed.parsed.frontmatter;
          const rfcStatus = String(fm["status"] ?? "").trim();
          const liveSpec = fm["liveSpec"];
          const rfcId = String(fm["id"] ?? "");

          if (!liveSpec || rfcStatus !== "implemented") {
            if (liveSpec && rfcStatus === "rejected") {
              liveMergeSkipped++;
              if (outputFormat === "pretty") {
                logger.info(`  spec.live.merge: skipping ${rfcId} (status: rejected)`);
              }
            }
            continue;
          }
          if (statusFilter && rfcStatus !== statusFilter) continue;

          try {
            const mergeInput: ForgeCommandInput = {
              argv: [],
              flags: { id: rfcId, "dry-run": dryRun },
            };
            const mergeResult = await runSpecLiveMerge(mergeInput, context);
            const mergeData = mergeResult.data as
              { domain?: string; operation?: string; conflicts?: unknown[] } | undefined;
            if (mergeData) {
              liveMergeResults.push({
                id: rfcId,
                domain: String(mergeData.domain ?? ""),
                operation: String(mergeData.operation ?? ""),
                conflicts: Array.isArray(mergeData.conflicts) ? mergeData.conflicts.length : 0,
              });
            }
          } catch (err) {
            if (outputFormat === "pretty") {
              logger.error(
                `  spec.live.merge: failed for ${rfcId}: ${String((err as Error).message)}`,
              );
            }
          }
        }

        if (liveMergeResults.length > 0 || liveMergeSkipped > 0) {
          results["spec.live.merge"] = {
            merged: liveMergeResults,
            skipped: liveMergeSkipped,
            dryRun,
          };
          if (outputFormat === "pretty") {
            for (const r of liveMergeResults) {
              logger.info(
                `  spec.live.merge: ${r.id} → ${r.domain} (${r.operation})${r.conflicts > 0 ? ` [${r.conflicts} conflicts]` : ""}${dryRun ? " [dry-run]" : ""}`,
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
          data: {
            command: "docs.archive",
            status: "ok",
            totalMoved,
            totalSkipped,
            results,
            dryRun,
            liveSpecMerges: liveMergeResults.length,
            liveSpecSkipped: liveMergeSkipped,
          },
          summary: dryRun
            ? `[dry-run] Would move ${totalMoved} file(s), skip ${totalSkipped}`
            : `Moved ${totalMoved} file(s), skipped ${totalSkipped}`,
        };
      },
    });
  },
};
