/*
<MODULE_CONTRACT>
<purpose>exploration.archive handler — transition an exploration note to archived status.</purpose>
<non-goals>
  <item>Do not delete exploration notes — archive is a status transition only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0710: initial exploration.archive handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  readAndParseExplorationNote,
  serializeExplorationNote,
  getExplorationsDir,
} from "../frontmatter-io.ts";
import {
  EXPLORATION_SLUG_PATTERN,
  type ExplorationArchiveResult,
} from "../types.ts";

function parseRelatedArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export async function runExplorationArchive(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ExplorationArchiveResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const explorationsDirPath = getExplorationsDir(workspaceRoot);

  const slug = input.flags["id"] as string | undefined;
  if (!slug) {
    return {
      data: {
        command: "exploration.archive",
        status: "error",
        id: "",
        previousStatus: "",
        newStatus: "archived",
        related: [],
      },
      exitCode: 1,
      summary: "exploration.archive requires --id <slug>",
    };
  }

  if (!EXPLORATION_SLUG_PATTERN.test(slug)) {
    if (outputFormat === "pretty") {
      logger.info(`Invalid slug: ${slug}. Must be kebab-case, lowercase, latin-only.`);
    }
    return {
      data: {
        command: "exploration.archive",
        status: "error",
        id: slug,
        previousStatus: "",
        newStatus: "archived",
        related: [],
      },
      exitCode: 1,
      summary: `Invalid slug: ${slug}`,
    };
  }

  const fileName = `${slug}.md`;
  const filePath = path.join(explorationsDirPath, fileName);
  const result = await readAndParseExplorationNote(explorationsDirPath, fileName);
  if (!result) {
    if (outputFormat === "pretty") {
      logger.info(`Exploration note not found: ${slug}`);
    }
    return {
      data: {
        command: "exploration.archive",
        status: "error",
        id: slug,
        previousStatus: "",
        newStatus: "archived",
        related: [],
      },
      exitCode: 1,
      summary: `Exploration note not found: ${slug}`,
    };
  }

  const fm = result.parsed.frontmatter;
  const previousStatus = String(fm["status"] ?? "open");
  const related = parseRelatedArray(fm["related"]);

  const rfcId = input.flags["rfc"] as string | undefined;
  if (rfcId && !related.includes(rfcId)) {
    related.push(rfcId);
  }

  if (previousStatus === "archived") {
    if (outputFormat === "pretty") {
      logger.info(`Exploration note ${slug} is already archived (no-op).`);
    }
    return {
      data: {
        command: "exploration.archive",
        status: "ok",
        id: slug,
        previousStatus: "archived",
        newStatus: "archived",
        related,
      },
      exitCode: 0,
      summary: `Exploration note ${slug} is already archived (no-op)`,
    };
  }

  const updatedFrontmatter: Record<string, unknown> = {
    ...fm,
    status: "archived",
    related,
  };

  const updatedContent = serializeExplorationNote(updatedFrontmatter, result.parsed.body);
  await fs.writeFile(filePath, updatedContent, "utf-8");

  if (outputFormat === "pretty") {
    logger.success(`Archived exploration note: ${slug} (${previousStatus} → archived)`);
    if (rfcId) {
      logger.info(`Related RFC: ${rfcId}`);
    }
  }

  return {
    data: {
      command: "exploration.archive",
      status: "ok",
      id: slug,
      previousStatus,
      newStatus: "archived",
      related,
    },
    summary: `Archived exploration note: ${slug} (${previousStatus} → archived)`,
  };
}
