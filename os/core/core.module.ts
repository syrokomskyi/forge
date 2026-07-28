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
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeNextStep,
  ForgeRuntimeContext,
} from "../../src/types.ts";
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
      flags: {},
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
        "Validate all forge skills against frontmatter contract and invariants SKILL-01..SKILL-13.",
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
        "Create a new forge project in one command: scaffold + init + binding defaults. Usage: forge create <name> [--profile forge-shell] [--package-manager pnpm]",
      scope: "workspace",
      supportsAllSites: false,
      flags: {
        profile: {
          kind: "string",
          description: "Stack profile id (default: forge-shell).",
        },
        "package-manager": {
          kind: "string",
          description: "Package manager to write into forge.yaml (default: pnpm).",
        },
      },
      cacheable: false,
      execute: createWrapper,
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
          },
          summary: dryRun
            ? `[dry-run] Would move ${totalMoved} file(s), skip ${totalSkipped}`
            : `Moved ${totalMoved} file(s), skipped ${totalSkipped}`,
        };
      },
    });
  },
};
