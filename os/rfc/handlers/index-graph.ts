/*
<MODULE_CONTRACT>
<purpose>Maintains packages/os/site-kernel/src/rfc/handlers/index-graph.ts as an authored site-kernel authored module so agents can evolve it without rediscovering local boundaries.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0303: extracted index and graph handlers from handlers.ts into handlers/index-graph.ts.</item>
  <item>Post-refactor hardening: rfc.graph resolves archived RFC files by basename id.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { listRfcFiles, readAndParseRfc, rfcFileMatchesId } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type {
  RfcStatus,
  RfcKind,
  RfcIndexEntry,
  RfcIndexResult,
  RfcGraphResult,
} from "../types.ts";
import { RFC_DIR } from "../types.ts";
import { toIsoDate } from "./shared.ts";

export async function runRfcIndexGenerate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcIndexResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const files = await listRfcFiles(rfcDirPath);
  const entries: RfcIndexEntry[] = [];
  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (!result || "error" in result) continue;
    const fm = result.parsed.frontmatter;
    const arr = (k: string): string[] =>
      Array.isArray(fm[k]) ? (fm[k] as unknown[]).map(String) : [];
    entries.push({
      id: String(fm["id"] ?? ""),
      title: String(fm["title"] ?? ""),
      status: String(fm["status"] ?? "") as RfcStatus,
      kind: String(fm["kind"] ?? "") as RfcKind,
      createdAt: String(fm["createdAt"] ?? ""),
      implementedAt: String(fm["implementedAt"] ?? ""),
      closedAt: String(fm["closedAt"] ?? ""),
      supersedes: arr("supersedes"),
      supersededBy: String(fm["supersededBy"] ?? ""),
      amends: arr("amends"),
      amendedBy: arr("amendedBy"),
      related: arr("related"),
      file: path.join(RFC_DIR, fileName),
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));

  let written: string | undefined;
  if (input.flags["write"] === true) {
    const outRel = path.join(RFC_DIR, "index.yaml");
    const payload = {
      command: "rfc.index.generate",
      generatedAt: toIsoDate(new Date()),
      count: entries.length,
      entries,
    };
    await fs.writeFile(path.join(workspaceRoot, outRel), `${yamlStringify(payload)}`, "utf-8");
    written = outRel;
  }

  if (outputFormat === "pretty") {
    logger.section(`RFC index (${entries.length} RFC(s))`);
    if (written) logger.success(`Wrote ${written}`);
    else logger.info("Use --json for the index, or --write to persist docs/rfcs/index.yaml.");
  }

  return {
    data: { command: "rfc.index.generate", status: "ok", count: entries.length, entries, written },
    summary: written
      ? `Wrote ${written} (${entries.length} RFCs)`
      : `Indexed ${entries.length} RFC(s)`,
  };
}

export async function runRfcGraph(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcGraphResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const targetId = input.flags["id"] as string | undefined;
  if (!targetId) {
    throw new Error("rfc.graph requires an RFC id, e.g. site-kernel run rfc.graph --id RFC-0152");
  }

  const files = await listRfcFiles(rfcDirPath);
  const fileName = files.find((f) => rfcFileMatchesId(f, targetId));
  if (!fileName) {
    throw new Error(`No RFC file found for id ${targetId} in ${RFC_DIR}/`);
  }
  const result = await readAndParseRfc(rfcDirPath, fileName);
  if (!result || "error" in result) {
    throw new Error(`Could not parse RFC ${targetId}: ${result?.error ?? "file not found"}`);
  }
  const fm = result.parsed.frontmatter;
  const arr = (k: string): string[] =>
    Array.isArray(fm[k]) ? (fm[k] as unknown[]).map(String) : [];

  const data: RfcGraphResult = {
    command: "rfc.graph",
    status: "ok",
    id: targetId,
    supersedes: arr("supersedes"),
    supersededBy: String(fm["supersededBy"] ?? ""),
    amends: arr("amends"),
    amendedBy: arr("amendedBy"),
    related: arr("related"),
  };

  if (outputFormat === "pretty") {
    logger.section(`${targetId} relationships`);
    logger.info(`supersedes:   ${data.supersedes.join(", ") || "—"}`);
    logger.info(`supersededBy: ${data.supersededBy || "—"}`);
    logger.info(`amends:       ${data.amends.join(", ") || "—"}`);
    logger.info(`amendedBy:    ${data.amendedBy.join(", ") || "—"}`);
    logger.info(`related:      ${data.related.join(", ") || "—"}`);
  }

  return {
    data,
    summary: `${targetId}: ${data.supersedes.length} supersedes, ${data.amends.length} amends, ${data.related.length} related`,
  };
}

export async function runRfcIndexValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    command: string;
    status: string;
    violations: { rule: string; message: string }[];
  }>
> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);
  const indexPath = path.join(rfcDirPath, "index.yaml");

  const violations: { rule: string; message: string }[] = [];

  // RFC-IDX-01: missing index file
  let indexContent: string;
  try {
    indexContent = await fs.readFile(indexPath, "utf-8");
  } catch {
    violations.push({
      rule: "RFC-IDX-01",
      message:
        "docs/rfcs/index.yaml not found. Run `pnpm exec werkstatt run rfc.index.generate --write` to generate it.",
    });
    const result = { command: "rfc.index.validate", status: "fail", violations };
    if (outputFormat === "pretty") {
      logger.error("RFC-IDX-01: docs/rfcs/index.yaml not found.");
    }
    return {
      data: result,
      exitCode: 1,
      summary: "1 error(s) found",
    };
  }

  // RFC-IDX-02: unparseable YAML
  let parsed: { entries?: unknown[] } | null;
  try {
    parsed = yamlParse(indexContent) as { entries?: unknown[] } | null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    violations.push({
      rule: "RFC-IDX-02",
      message: `Failed to parse docs/rfcs/index.yaml: ${msg}`,
    });
    const result = { command: "rfc.index.validate", status: "fail", violations };
    if (outputFormat === "pretty") {
      logger.error(`RFC-IDX-02: Failed to parse index.yaml: ${msg}`);
    }
    return {
      data: result,
      exitCode: 1,
      summary: "1 error(s) found",
    };
  }

  // RFC-IDX-03: count mismatch
  const indexCount = Array.isArray(parsed?.entries) ? parsed!.entries!.length : 0;
  const allFiles = await listRfcFiles(rfcDirPath);
  const fileCount = allFiles.length;

  if (indexCount !== fileCount) {
    violations.push({
      rule: "RFC-IDX-03",
      message: `Index entry count (${indexCount}) does not match RFC file count (${fileCount}). Run \`pnpm exec werkstatt run rfc.index.generate --write\` to refresh.`,
    });
  }

  const hasErrors = violations.length > 0;
  const resultStatus = hasErrors ? "fail" : "pass";
  const result = { command: "rfc.index.validate", status: resultStatus, violations };

  if (outputFormat === "pretty") {
    if (hasErrors) {
      for (const v of violations) {
        logger.error(`[${v.rule}] ${v.message}`);
      }
      logger.error(`${violations.length} error(s) found`);
    } else {
      logger.success(`Index valid — ${indexCount} entries match ${fileCount} RFC files.`);
    }
  }

  return {
    data: result,
    exitCode: hasErrors ? 1 : 0,
    summary: hasErrors
      ? `${violations.length} error(s) found`
      : `Index valid — ${indexCount} entries match ${fileCount} RFC files`,
  };
}
