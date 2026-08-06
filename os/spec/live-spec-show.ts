/*
<MODULE_CONTRACT>
<purpose>spec.live.show handler — reads and returns a single living spec by domain (RFC-0711).</purpose>
<non-goals>
  <item>Do not merge or validate — use spec.live.merge / spec.live.validate.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial spec.live.show handler.</item>
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
import type { SpecLiveShowResult, LivingSpecHistoryEntry } from "./live-spec-types.ts";

const LIVE_SPECS_DIR = "docs/specs/live";

export async function runSpecLiveShow(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SpecLiveShowResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const domain = String(input.flags["domain"] ?? "");

  if (!domain) {
    return {
      data: {
        command: "spec.live.show",
        status: "ok",
        domain: "",
        title: "",
        lastMergedRfc: "",
        updatedAt: "",
        createdAt: "",
        history: [],
        body: "",
      },
      exitCode: 1,
      summary: "spec.live.show: --domain flag is required",
    };
  }

  const specFilePath = path.join(workspaceRoot, LIVE_SPECS_DIR, `${domain}.md`);

  if (!existsSync(specFilePath)) {
    return {
      data: {
        command: "spec.live.show",
        status: "ok",
        domain,
        title: "",
        lastMergedRfc: "",
        updatedAt: "",
        createdAt: "",
        history: [],
        body: "",
      },
      exitCode: 1,
      summary: `spec.live.show: living spec "${domain}" not found at ${specFilePath}`,
    };
  }

  const content = await fs.readFile(specFilePath, "utf-8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      data: {
        command: "spec.live.show",
        status: "ok",
        domain,
        title: "",
        lastMergedRfc: "",
        updatedAt: "",
        createdAt: "",
        history: [],
        body: content,
      },
      exitCode: 1,
      summary: `spec.live.show: living spec "${domain}" has invalid frontmatter`,
    };
  }

  const fm = (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
  const result: SpecLiveShowResult = {
    command: "spec.live.show",
    status: "ok",
    domain: String(fm["domain"] ?? domain),
    title: String(fm["title"] ?? ""),
    lastMergedRfc: String(fm["lastMergedRfc"] ?? ""),
    updatedAt: String(fm["updatedAt"] ?? ""),
    createdAt: String(fm["createdAt"] ?? ""),
    history: (Array.isArray(fm["history"]) ? fm["history"] : []) as LivingSpecHistoryEntry[],
    body: match[2] ?? "",
  };

  if (outputFormat === "pretty") {
    logger.section(`Living Spec: ${result.domain}`);
    logger.info(`Title: ${result.title}`);
    logger.info(`Last merged RFC: ${result.lastMergedRfc}`);
    logger.info(`Updated: ${result.updatedAt}`);
    logger.info(`History entries: ${result.history.length}`);
  }

  return {
    data: result,
    exitCode: 0,
    summary: `spec.live.show: ${domain}`,
  };
}
