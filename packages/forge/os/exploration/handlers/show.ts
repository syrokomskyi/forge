/*
<MODULE_CONTRACT>
<purpose>exploration.show handler — return the full content of a single exploration note.</purpose>
<non-goals>
  <item>Do not validate frontmatter shape — show returns raw parsed content.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0710: initial exploration.show handler.</item>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { readAndParseExplorationNote, getExplorationsDir } from "../frontmatter-io.ts";
import type { ExplorationNote, ExplorationShowResult, ExplorationStatus } from "../types.ts";

function parseRelatedArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export async function runExplorationShow(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ExplorationShowResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const explorationsDirPath = getExplorationsDir(workspaceRoot);

  const slug = input.flags["id"] as string | undefined;
  if (!slug) {
    return {
      data: {
        command: "exploration.show",
        status: "error",
        note: {
          id: "",
          title: "",
          createdAt: "",
          status: "open",
          related: [],
          body: "",
        },
      },
      exitCode: 1,
      summary: "exploration.show requires --id <slug>",
    };
  }

  const fileName = `${slug}.md`;
  const result = await readAndParseExplorationNote(explorationsDirPath, fileName);
  if (!result) {
    if (outputFormat === "pretty") {
      logger.info(`Exploration note not found: ${slug}`);
    }
    return {
      data: {
        command: "exploration.show",
        status: "error",
        note: {
          id: slug,
          title: "",
          createdAt: "",
          status: "open",
          related: [],
          body: "",
        },
      },
      exitCode: 1,
      summary: `Exploration note not found: ${slug}`,
    };
  }

  const fm = result.parsed.frontmatter;
  const note: ExplorationNote = {
    id: String(fm["id"] ?? slug),
    title: String(fm["title"] ?? ""),
    createdAt: String(fm["createdAt"] ?? ""),
    status: String(fm["status"] ?? "open") as ExplorationStatus,
    related: parseRelatedArray(fm["related"]),
    body: result.parsed.body,
  };

  if (outputFormat === "pretty") {
    logger.section(`Exploration: ${note.title}`);
    logger.info(`ID: ${note.id}  Status: ${note.status}  Created: ${note.createdAt}`);
    if (note.related.length > 0) {
      logger.info(`Related: ${note.related.join(", ")}`);
    }
    logger.info("");
    logger.info(note.body.trim());
  }

  return {
    data: {
      command: "exploration.show",
      status: "ok",
      note,
    },
    summary: `Exploration note: ${note.id}`,
  };
}
