/*
<MODULE_CONTRACT>
<purpose>
RFC-0329: collect decision log entries from all RFCs, score against
keywords for rfc.create consultation, and generate/validate projections.
</purpose>
<non-goals>
  <item>Do not use LLM/embeddings for matching — keyword scoring only.</item>
  <item>Do not block rfc.create when matches are found — consultation is informative.</item>
  <item>Do not wire generation into build pipelines — on-demand only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0329: initial implementation.</item>
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../../src/utils/fs-atomic.ts";
import { buildGeneratedHeader } from "../../src/utils/generated-marker.ts";
import { stringify as yamlStringify } from "yaml";
import { listRfcFiles, readAndParseRfc } from "./frontmatter-io.ts";
import { RFC_DIR } from "./types.ts";
import type {
  DecisionLogEntry,
  DecisionLogEntryKind,
  DecisionLogResult,
  ConsultedDecision,
  RfcStatus,
} from "./types.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

const STOPWORDS = new Set(["the", "and", "for", "add", "into", "with", "from", "that"]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const match = re.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextHeading = body.indexOf("\n## ", start);
  const sectionText =
    nextHeading === -1 ? body.slice(start).trim() : body.slice(start, nextHeading).trim();
  return sectionText || null;
}

function firstParagraph(text: string): string {
  const trimmed = text.trim();
  const firstBreak = trimmed.indexOf("\n\n");
  return firstBreak === -1 ? trimmed : trimmed.slice(0, firstBreak).trim();
}

export async function collectDecisionLog(rfcDirPath: string): Promise<DecisionLogEntry[]> {
  const files = await listRfcFiles(rfcDirPath);
  const entries: DecisionLogEntry[] = [];

  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (!result || "error" in result) continue;
    const fm = result.parsed.frontmatter;
    const body = result.parsed.body;
    const rfcId = String(fm["id"] ?? "");
    const title = String(fm["title"] ?? "");
    const status = String(fm["status"] ?? "") as RfcStatus;
    const file = join(RFC_DIR, fileName);

    if (status === "rejected") {
      const decisionSection = extractSection(body, "Decision");
      entries.push({
        kind: "rejected-rfc",
        rfcId,
        title,
        status,
        closedAt: String(fm["closedAt"] ?? "") || undefined,
        decisionSummary: decisionSection ? firstParagraph(decisionSection) : undefined,
        alternativesText: extractSection(body, "Alternatives considered") ?? undefined,
        file,
      });
    } else if (status === "superseded") {
      const decisionSection = extractSection(body, "Decision");
      const supersededBy = fm["supersededBy"];
      entries.push({
        kind: "superseded-rfc",
        rfcId,
        title,
        status,
        closedAt: String(fm["closedAt"] ?? "") || undefined,
        supersededBy:
          Array.isArray(supersededBy) && supersededBy.length > 0
            ? String(supersededBy[0])
            : undefined,
        decisionSummary: decisionSection ? firstParagraph(decisionSection) : undefined,
        file,
      });
    }

    const alternativesText = extractSection(body, "Alternatives considered");
    if (alternativesText) {
      entries.push({
        kind: "rejected-alternative",
        rfcId,
        title,
        status,
        alternativesText,
        file,
      });
    }
  }

  entries.sort((a, b) => a.rfcId.localeCompare(b.rfcId));
  return entries;
}

export function scoreDecisions(
  title: string,
  entries: DecisionLogEntry[],
  limit = 5,
): ConsultedDecision[] {
  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return [];

  const scored: ConsultedDecision[] = [];
  for (const entry of entries) {
    const entryTitleTokens = tokenize(entry.title);
    const entryTextTokens = new Set([
      ...entryTitleTokens,
      ...tokenize(entry.decisionSummary ?? ""),
      ...tokenize(entry.alternativesText ?? ""),
    ]);

    let score = 0;
    for (const token of titleTokens) {
      if (entryTitleTokens.includes(token)) score += 3;
      if (entryTextTokens.has(token)) score += 1;
    }

    if (score > 0) {
      scored.push({
        rfcId: entry.rfcId,
        kind: entry.kind,
        title: entry.title,
        score,
        file: entry.file,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.rfcId.localeCompare(b.rfcId));
  return scored.slice(0, limit);
}

function renderMarkdown(entries: DecisionLogEntry[]): string {
  const lines: string[] = [
    buildGeneratedHeader({
      ownerCommand: "rfc.decision-log.generate",
      filePath: "docs/rfcs/decision-log.generated.md",
    }).trimEnd(),
    "",
  ];
  const groups: Record<DecisionLogEntryKind, DecisionLogEntry[]> = {
    "rejected-rfc": [],
    "superseded-rfc": [],
    "rejected-alternative": [],
  };
  for (const e of entries) groups[e.kind].push(e);

  lines.push("# RFC Decision Log", "");
  lines.push(`> Generated projection of all rejected/superseded RFCs and rejected alternatives.`);
  lines.push(
    `> Do not edit — run \`site-kernel run rfc.decision-log.generate\` to regenerate.`,
    "",
  );

  for (const kind of Object.keys(groups) as DecisionLogEntryKind[]) {
    const groupEntries = groups[kind];
    if (groupEntries.length === 0) continue;
    lines.push(`## ${kind} (${groupEntries.length})`, "");
    for (const e of groupEntries) {
      lines.push(`### ${e.rfcId}: ${e.title}`, "");
      lines.push(`- **Status:** ${e.status}`);
      if (e.closedAt) lines.push(`- **Closed:** ${e.closedAt}`);
      if (e.supersededBy) lines.push(`- **Superseded by:** ${e.supersededBy}`);
      if (e.decisionSummary) lines.push(`- **Decision:** ${e.decisionSummary}`);
      if (e.alternativesText) {
        lines.push("- **Alternatives considered:**", "");
        lines.push(e.alternativesText);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runRfcDecisionLogGenerate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<DecisionLogResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const checkMode = Boolean(input.flags["check"]);
  const rfcDirPath = join(workspaceRoot, RFC_DIR);

  const entries = await collectDecisionLog(rfcDirPath);

  const jsonRelPath = join(RFC_DIR, "decision-log.generated.yaml");
  const mdRelPath = join(RFC_DIR, "decision-log.generated.md");

  if (checkMode) {
    const diagnostics: Diagnostic[] = [];
    let drift = false;

    try {
      const existingJson = await readFile(join(workspaceRoot, jsonRelPath), "utf-8");
      const expectedJson = `${buildGeneratedHeader({ filePath: jsonRelPath, ownerCommand: "rfc.decision-log.generate" })}${yamlStringify({ command: "rfc.decision-log.generate", status: "ok", count: entries.length, entries })}\n`;
      if (existingJson !== expectedJson) {
        drift = true;
        diagnostics.push({
          ruleId: "DECISION-LOG-DRIFT",
          severity: "error",
          file: jsonRelPath,
          message: "JSON projection drifts from recomputed content.",
        });
      }
    } catch {
      drift = true;
      diagnostics.push({
        ruleId: "DECISION-LOG-MISSING",
        severity: "error",
        file: jsonRelPath,
        message: `${jsonRelPath} does not exist — run without --check first.`,
      });
    }

    try {
      const existingMd = await readFile(join(workspaceRoot, mdRelPath), "utf-8");
      const expectedMd = renderMarkdown(entries);
      if (existingMd !== expectedMd) {
        drift = true;
        diagnostics.push({
          ruleId: "DECISION-LOG-DRIFT",
          severity: "error",
          file: mdRelPath,
          message: "Markdown projection drifts from recomputed content.",
        });
      }
    } catch {
      drift = true;
      diagnostics.push({
        ruleId: "DECISION-LOG-MISSING",
        severity: "error",
        file: mdRelPath,
        message: `${mdRelPath} does not exist — run without --check first.`,
      });
    }

    if (outputFormat === "pretty") {
      if (drift) {
        for (const d of diagnostics) logger.error(`[${d.ruleId}] ${d.message}`);
      } else {
        logger.success("Decision log projections are up to date.");
      }
    }

    return {
      data: {
        command: "rfc.decision-log.generate",
        status: drift ? "drift" : "ok",
        count: entries.length,
        entries,
      },
      exitCode: drift ? 1 : 0,
      summary: `rfc.decision-log.generate --check: ${drift ? "drift detected" : "up to date"} (${entries.length} entries)`,
    };
  }

  const jsonContent = `${buildGeneratedHeader({ filePath: jsonRelPath, ownerCommand: "rfc.decision-log.generate" })}${yamlStringify({ command: "rfc.decision-log.generate", status: "ok", count: entries.length, entries })}\n`;
  const mdContent = renderMarkdown(entries);

  await writeFileAtomic(join(workspaceRoot, jsonRelPath), jsonContent);
  await writeFileAtomic(join(workspaceRoot, mdRelPath), mdContent);

  if (outputFormat === "pretty") {
    logger.success(`Wrote ${jsonRelPath} and ${mdRelPath} (${entries.length} entries)`);
  }

  return {
    data: {
      command: "rfc.decision-log.generate",
      status: "ok",
      count: entries.length,
      entries,
      written: [jsonRelPath, mdRelPath],
    },
    exitCode: 0,
    summary: `rfc.decision-log.generate: wrote ${entries.length} entries to JSON + Markdown`,
  };
}
