/*
<MODULE_CONTRACT>
<purpose>spec.live.list handler — lists all living specs in docs/specs/live/ (RFC-0711).</purpose>
<non-goals>
  <item>Do not merge or validate — use spec.live.merge / spec.live.validate.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial spec.live.list handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import type { SpecLiveListResult, SpecLiveListEntry } from "./live-spec-types.ts";

const LIVE_SPECS_DIR = "docs/specs/live";

export async function runSpecLiveList(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SpecLiveListResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const liveSpecsDir = path.join(workspaceRoot, LIVE_SPECS_DIR);

  const entries: SpecLiveListEntry[] = [];

  if (existsSync(liveSpecsDir)) {
    const files = await fs.readdir(liveSpecsDir);
    for (const file of files) {
      if (!file.endsWith(".md") || file === "README.md") continue;
      const filePath = path.join(liveSpecsDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) continue;
      const fm = (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
      entries.push({
        domain: String(fm["domain"] ?? ""),
        title: String(fm["title"] ?? ""),
        lastMergedRfc: String(fm["lastMergedRfc"] ?? ""),
        updatedAt: String(fm["updatedAt"] ?? ""),
        historyCount: Array.isArray(fm["history"]) ? fm["history"].length : 0,
      });
    }
  }

  entries.sort((a, b) => a.domain.localeCompare(b.domain));

  const result: SpecLiveListResult = {
    command: "spec.live.list",
    status: "ok",
    livingSpecs: entries,
  };

  if (outputFormat === "pretty") {
    if (entries.length === 0) {
      logger.info("spec.live.list: no living specs found");
    } else {
      logger.section(`Living Specs (${entries.length})`);
      for (const entry of entries) {
        logger.info(`  ${entry.domain} — ${entry.title} (last: ${entry.lastMergedRfc})`);
      }
    }
  }

  return {
    data: result,
    exitCode: 0,
    summary: `spec.live.list: ${entries.length} living spec(s)`,
  };
}
