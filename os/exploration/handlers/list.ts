/*
<MODULE_CONTRACT>
<purpose>exploration.list handler — list all exploration notes with metadata.</purpose>
<non-goals>
  <item>Do not validate frontmatter shape — listing is metadata-only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0710: initial exploration.list handler.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  listExplorationFiles,
  readAndParseExplorationNote,
  getExplorationsDir,
} from "../frontmatter-io.ts";
import type { ExplorationListEntry, ExplorationListResult, ExplorationStatus } from "../types.ts";

export async function runExplorationList(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ExplorationListResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const explorationsDirPath = getExplorationsDir(workspaceRoot);

  const filterStatus = input.flags["status"] as string | undefined;

  const files = await listExplorationFiles(explorationsDirPath);
  const entries: ExplorationListEntry[] = [];

  for (const fileName of files) {
    const result = await readAndParseExplorationNote(explorationsDirPath, fileName);
    if (!result) continue;

    const fm = result.parsed.frontmatter;
    const status = String(fm["status"] ?? "") as ExplorationStatus;

    if (filterStatus && status !== filterStatus) continue;

    entries.push({
      id: String(fm["id"] ?? path.basename(fileName, ".md")),
      title: String(fm["title"] ?? ""),
      status,
      createdAt: String(fm["createdAt"] ?? ""),
    });
  }

  if (outputFormat === "pretty") {
    if (entries.length === 0) {
      logger.info("No exploration notes found.");
    } else {
      logger.section(`Exploration notes (${entries.length})`);
      for (const entry of entries) {
        logger.info(
          `${entry.id}  ${entry.status.padEnd(10)} ${entry.createdAt.padEnd(12)} ${entry.title}`,
        );
      }
    }
  }

  return {
    data: {
      command: "exploration.list",
      status: "ok",
      count: entries.length,
      explorations: entries,
    },
    summary: `${entries.length} exploration note(s) found`,
  };
}
