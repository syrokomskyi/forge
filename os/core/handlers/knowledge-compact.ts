/*
<MODULE_CONTRACT>
<purpose>Command handler for forge.skill.knowledge.compact — wraps pure compaction functions in the kernel command contract (RFC-0662).</purpose>
<non-goals>
  <item>Do not implement planning logic — that lives in src/knowledge/compact.ts.</item>
  <item>Do not import from @warpgogol/* — os/core may use dynamic imports but this handler stays forge-internal.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0662: initial knowledge compaction command handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { FORGE_SKILLS, discoverPackSkills } from "../../../src/registry.ts";
import { loadForgeConfig } from "../../../src/config/forge-config.ts";
import { resolveForgeRoot } from "../../../src/config/forge-config.ts";
import {
  planCompaction,
  executeCompaction,
  resolveRetentionDays,
  resolveStaleDays,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_STALE_DAYS,
  type CompactReport,
} from "../../../src/knowledge/compact.ts";
import { parseKnowledgeFile } from "../../../src/knowledge/parse.ts";
import type { ParsedKnowledgeFile } from "../../../src/knowledge/schema.ts";

interface SkillKnowledgeFiles {
  skill: string;
  files: string[];
}

function discoverSkillKnowledgeFiles(
  workspaceRoot: string,
  skillName: string | undefined,
  all: boolean,
): SkillKnowledgeFiles[] {
  const result: SkillKnowledgeFiles[] = [];
  const config = loadForgeConfig(workspaceRoot);

  // Resolve forge root
  let forgeRoot: string;
  try {
    forgeRoot = resolveForgeRoot(workspaceRoot);
  } catch {
    return result;
  }

  const skillsRoot = path.join(forgeRoot, "skills");

  // Collect forge skills
  for (const skill of FORGE_SKILLS) {
    if (skillName && skill.name !== skillName) continue;
    if (!skill.knowledge || skill.knowledge.length === 0) continue;

    const skillDir = path.dirname(path.join(skillsRoot, skill.path));
    const files = skill.knowledge
      .map((f) => path.join(skillDir, f))
      .filter((f) => {
        try {
          return fs.existsSync(f);
        } catch {
          return false;
        }
      });

    if (files.length > 0) {
      result.push({ skill: skill.name, files });
    }
  }

  // Collect pack skills if --all or if --skill matches a pack skill
  if (all || (skillName && !result.some((r) => r.skill === skillName))) {
    const packSkills = discoverPackSkills(workspaceRoot, config);
    for (const skill of packSkills) {
      if (skillName && skill.name !== skillName) continue;
      if (!skill.knowledge || skill.knowledge.length === 0) continue;

      const packDir = path.resolve(workspaceRoot, skill.dir);
      const skillDir = path.dirname(path.join(packDir, skill.path));
      const files = skill.knowledge
        .map((f) => path.join(skillDir, f))
        .filter((f) => {
          try {
            return fs.existsSync(f);
          } catch {
            return false;
          }
        });

      if (files.length > 0) {
        result.push({ skill: skill.name, files });
      }
    }
  }

  return result;
}

export async function runKnowledgeCompact(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<CompactReport>> {
  const { flags } = input;
  const skillName = typeof flags["skill"] === "string" ? flags["skill"] : undefined;
  const all = flags["all"] === true;
  const dryRun = context.dryRun || flags["dry-run"] === true;
  const json = flags["json"] === true;

  // Validate exactly one of --skill / --all
  if (!skillName && !all) {
    return {
      data: {
        command: "forge.skill.knowledge.compact",
        status: "fail",
        dryRun,
        files: [],
        totals: { archived: 0, markedStale: 0, legacyFiles: 0 },
        errors: ["Exactly one of --skill <name> or --all is required."],
      },
      exitCode: 1,
      summary: "Error: --skill or --all is required.",
    };
  }

  if (skillName && all) {
    return {
      data: {
        command: "forge.skill.knowledge.compact",
        status: "fail",
        dryRun,
        files: [],
        totals: { archived: 0, markedStale: 0, legacyFiles: 0 },
        errors: ["--skill and --all are mutually exclusive."],
      },
      exitCode: 1,
      summary: "Error: --skill and --all are mutually exclusive.",
    };
  }

  // Resolve retention and stale days
  const flagRetention =
    typeof flags["retention-days"] === "string" ? Number(flags["retention-days"]) : undefined;
  const flagStale =
    typeof flags["stale-days"] === "string" ? Number(flags["stale-days"]) : undefined;

  const retentionDays =
    flagRetention !== undefined && flagRetention > 0 && Number.isInteger(flagRetention)
      ? flagRetention
      : resolveRetentionDays(context.workspaceRoot);
  const staleDays =
    flagStale !== undefined && flagStale > 0 && Number.isInteger(flagStale)
      ? flagStale
      : resolveStaleDays(context.workspaceRoot);

  // Discover target skills and their knowledge files
  const skillFiles = discoverSkillKnowledgeFiles(context.workspaceRoot, skillName, all);

  if (skillFiles.length === 0) {
    const summary = skillName
      ? `Skill "${skillName}" has no knowledge files to compact.`
      : "No skills with knowledge files found.";
    return {
      data: {
        command: "forge.skill.knowledge.compact",
        status: "pass",
        dryRun,
        files: [],
        totals: { archived: 0, markedStale: 0, legacyFiles: 0 },
      },
      exitCode: 0,
      summary,
    };
  }

  // Parse all knowledge files
  const today = new Date().toISOString().slice(0, 10);
  const allParsed: ParsedKnowledgeFile[] = [];
  const fileToSkill = new Map<string, string>();

  for (const { skill, files } of skillFiles) {
    for (const file of files) {
      const parsed = parseKnowledgeFile(file);
      allParsed.push(parsed);
      fileToSkill.set(file, skill);
    }
  }

  // Plan compaction
  const plans = planCompaction(allParsed, { retentionDays, staleDays, today });

  // Execute compaction
  const report = executeCompaction(plans, dryRun);

  // Group by skill for output
  const skillsOutput = skillFiles.map(({ skill, files }) => {
    const skillFileResults = report.files.filter((r) => files.includes(r.file));
    return {
      skill,
      files: skillFileResults.map((r) => ({
        file: path.basename(r.file),
        actions: r.actions,
        legacySectionCount: r.legacySectionCount,
      })),
    };
  });

  const groupedReport = {
    ...report,
    skills: skillsOutput,
  };

  const exitCode = report.status === "pass" ? 0 : 1;
  const summary = dryRun
    ? `[dry-run] forge.skill.knowledge.compact: ${report.totals.archived} would archive, ${report.totals.markedStale} would mark stale, ${report.totals.legacyFiles} legacy file(s)`
    : `forge.skill.knowledge.compact: ${report.totals.archived} archived, ${report.totals.markedStale} marked stale, ${report.totals.legacyFiles} legacy file(s)`;

  if (context.outputFormat === "pretty" && !json) {
    context.logger.section("Knowledge Compaction");
    for (const skill of skillsOutput) {
      context.logger.info(`Skill: ${skill.skill}`);
      for (const file of skill.files) {
        context.logger.info(
          `  ${file.file}: ${file.actions.length} action(s), ${file.legacySectionCount} legacy section(s)`,
        );
        for (const action of file.actions) {
          context.logger.info(`    ${action.kind}: ${action.entryId} — ${action.reason}`);
        }
      }
    }
    context.logger.info(
      `Totals: ${report.totals.archived} archived, ${report.totals.markedStale} marked stale, ${report.totals.legacyFiles} legacy file(s)`,
    );
  }

  return {
    data: groupedReport,
    exitCode,
    summary,
  };
}
