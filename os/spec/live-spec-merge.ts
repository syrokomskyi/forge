/*
<MODULE_CONTRACT>
<purpose>spec.live.merge handler — extracts deltas from an RFC's ## Design section,
classifies them as ADDED/MODIFIED/REMOVED, applies to a living spec, handles conflicts
with all-or-nothing semantics, and writes atomically (RFC-0711).</purpose>
<non-goals>
  <item>Do not handle docs.archive integration — that is in core.module.ts.</item>
  <item>Do not validate living specs — that is spec.live.validate.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial spec.live.merge handler with delta extraction, classification, conflict detection, and atomic writes.</item>
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
import { writeFileIfChanged, buildGeneratedHeader } from "../../src/utils/index.ts";
import { parseRfcFile, listRfcFiles } from "../rfc/frontmatter-io.ts";
import { RFC_DIR } from "../rfc/types.ts";
import type {
  LivingSpec,
  LivingSpecHistoryEntry,
  DeltaOperation,
  DeltaConflict,
  SpecLiveMergeResult,
} from "./live-spec-types.ts";

const LIVE_SPECS_DIR = "docs/specs/live";

interface ParsedHeading {
  level: number;
  text: string;
  body: string;
}

function extractDesignSection(rfcBody: string): string {
  const designMatch = rfcBody.match(/^##\s+Design\s*$/m);
  if (!designMatch) return "";
  const startIndex = designMatch.index! + designMatch[0].length;
  const nextH2Match = rfcBody.slice(startIndex).match(/^##\s+/m);
  if (!nextH2Match) {
    return rfcBody.slice(startIndex).trim();
  }
  return rfcBody.slice(startIndex, startIndex + nextH2Match.index!).trim();
}

function parseHeadings(content: string): ParsedHeading[] {
  const lines = content.split("\n");
  const headings: ParsedHeading[] = [];
  let currentHeading: ParsedHeading | null = null;
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{3,})\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading) {
        currentHeading.body = currentBody.join("\n").trim();
        headings.push(currentHeading);
      }
      currentHeading = {
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
        body: "",
      };
      currentBody = [];
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }
  if (currentHeading) {
    currentHeading.body = currentBody.join("\n").trim();
    headings.push(currentHeading);
  }
  return headings;
}

function deriveDomain(frontmatter: Record<string, unknown>): string | null {
  const liveSpec = frontmatter["liveSpec"];
  if (typeof liveSpec === "string" && liveSpec.length > 0) {
    return liveSpec;
  }
  if (liveSpec === true) {
    const packagesImpacted = frontmatter["packagesImpacted"];
    if (Array.isArray(packagesImpacted) && packagesImpacted.length > 0) {
      const firstPkg = String(packagesImpacted[0]);
      return firstPkg.replace(/^packages\//, "");
    }
    return null;
  }
  return null;
}

function parseLivingSpec(content: string): LivingSpec | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const fm = (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>;
  return {
    domain: String(fm["domain"] ?? ""),
    title: String(fm["title"] ?? ""),
    lastMergedRfc: String(fm["lastMergedRfc"] ?? ""),
    updatedAt: String(fm["updatedAt"] ?? ""),
    createdAt: String(fm["createdAt"] ?? ""),
    history: (Array.isArray(fm["history"]) ? fm["history"] : []) as LivingSpecHistoryEntry[],
    body: match[2] ?? "",
  };
}

function serializeLivingSpec(spec: LivingSpec): string {
  const fm: Record<string, unknown> = {
    domain: spec.domain,
    title: spec.title,
    lastMergedRfc: spec.lastMergedRfc,
    updatedAt: spec.updatedAt,
    createdAt: spec.createdAt,
    history: spec.history,
  };
  const fmStr = YAML.stringify(fm).trimEnd();
  return `---\n${fmStr}\n---\n\n${spec.body}`;
}

function findHeadingInSpec(spec: LivingSpec, headingText: string): ParsedHeading | null {
  const headings = parseHeadings(spec.body);
  return headings.find((h) => h.text === headingText) ?? null;
}

function applyDeltasToSpecBody(
  specBody: string,
  deltas: ParsedHeading[],
  operations: DeltaOperation[],
): string {
  let body = specBody;
  for (const delta of deltas) {
    const op = operations.find((o) => o.heading === delta.text);
    if (!op) continue;

    if (op.type === "added") {
      body = `${body}\n\n${"#".repeat(delta.level)} ${delta.text}\n\n${delta.body}`;
    } else if (op.type === "modified") {
      const headingRegex = new RegExp(
        `(${"#".repeat(delta.level)}\\s+${escapeRegex(delta.text)}\\s*\\n)([\\s\\S]*?)(?=#{3,}|$)`,
      );
      body = body.replace(headingRegex, `$1\n${delta.body}\n`);
    } else if (op.type === "removed") {
      const headingRegex = new RegExp(
        `\\n*${"#".repeat(delta.level)}\\s+${escapeRegex(delta.text)}\\s*\\n[\\s\\S]*?(?=#{3,}|$)`,
      );
      body = body.replace(headingRegex, "\n");
    }
  }
  return body.trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRfcFile(rfcDir: string, rfcId: string): Promise<string | null> {
  return (async () => {
    const files = await listRfcFiles(rfcDir);
    for (const file of files) {
      const basename = path.basename(file);
      if (basename.toLowerCase().startsWith(rfcId.toLowerCase())) {
        return file;
      }
    }
    return null;
  })();
}

export async function runSpecLiveMerge(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SpecLiveMergeResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcId = String(input.flags["id"] ?? "");
  const dryRun = context.dryRun || input.flags["dry-run"] === true;

  if (!rfcId) {
    return {
      data: {
        command: "spec.live.merge",
        domain: "",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 1,
      summary: "spec.live.merge: --id flag is required",
    };
  }

  const rfcDir = path.join(workspaceRoot, RFC_DIR);
  const rfcFile = await findRfcFile(rfcDir, rfcId);

  if (!rfcFile) {
    return {
      data: {
        command: "spec.live.merge",
        domain: "",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 1,
      summary: `spec.live.merge: RFC ${rfcId} not found in ${RFC_DIR}`,
    };
  }

  const rfcContent = await fs.readFile(path.join(rfcDir, rfcFile), "utf-8");
  const parsed = parseRfcFile(rfcContent);
  const fm = parsed.frontmatter;

  const status = String(fm["status"] ?? "").trim();
  if (status !== "implemented") {
    return {
      data: {
        command: "spec.live.merge",
        domain: "",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 1,
      summary: `spec.live.merge: RFC ${rfcId} has status "${status}", must be "implemented"`,
    };
  }

  const domain = deriveDomain(fm);
  if (!domain) {
    return {
      data: {
        command: "spec.live.merge",
        domain: "",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 0,
      summary: `spec.live.merge: RFC ${rfcId} has no liveSpec field — skipping (no-op)`,
    };
  }

  const designSection = extractDesignSection(parsed.body);
  if (!designSection) {
    return {
      data: {
        command: "spec.live.merge",
        domain,
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun,
      },
      exitCode: 0,
      summary: `spec.live.merge: RFC ${rfcId} has no ## Design section — skipping (no-op)`,
    };
  }

  const rfcHeadings = parseHeadings(designSection);
  const liveSpecsDir = path.join(workspaceRoot, LIVE_SPECS_DIR);
  const specFilePath = path.join(liveSpecsDir, `${domain}.md`);

  let existingSpec: LivingSpec | null = null;
  if (existsSync(specFilePath)) {
    const specContent = await fs.readFile(specFilePath, "utf-8");
    existingSpec = parseLivingSpec(specContent);
  }

  const operations: DeltaOperation[] = [];
  const conflicts: DeltaConflict[] = [];
  const today = new Date().toISOString().slice(0, 10);

  if (!existingSpec) {
    for (const heading of rfcHeadings) {
      operations.push({ type: "added", heading: heading.text, rfc: rfcId });
    }

    const header = buildGeneratedHeader({
      filePath: specFilePath,
      ownerCommand: "spec.live.merge",
      commandPrefix: "pnpm exec werkstatt run",
    });

    const newSpec: LivingSpec = {
      domain,
      title: `Living Spec: ${domain}`,
      lastMergedRfc: rfcId,
      updatedAt: today,
      createdAt: today,
      history: [{ rfc: rfcId, mergedAt: today, operation: "created" }],
      body: `${header}# Living Spec: ${domain}\n\n## Overview\n\n${designSection}`,
    };

    if (!dryRun) {
      await fs.mkdir(liveSpecsDir, { recursive: true });
      await writeFileIfChanged(specFilePath, serializeLivingSpec(newSpec));
    }

    const result: SpecLiveMergeResult = {
      command: "spec.live.merge",
      domain,
      operation: "created",
      deltas: operations,
      conflicts: [],
      dryRun,
    };

    if (outputFormat === "pretty") {
      logger.success(
        `spec.live.merge: created living spec for domain "${domain}" from ${rfcId} (${operations.length} deltas)${dryRun ? " [dry-run]" : ""}`,
      );
    }

    return { data: result, exitCode: 0, summary: `spec.live.merge: created ${domain} from ${rfcId}` };
  }

  for (const heading of rfcHeadings) {
    const existing = findHeadingInSpec(existingSpec, heading.text);
    if (existing) {
      let lastRfc: string | undefined;
      for (let i = existingSpec.history.length - 1; i >= 0; i--) {
        const entry = existingSpec.history[i]!;
        if (entry.operation !== "removed") {
          lastRfc = entry.rfc;
          break;
        }
      }
      if (lastRfc && lastRfc !== rfcId) {
        conflicts.push({
          heading: heading.text,
          existingRfc: lastRfc,
          newRfc: rfcId,
          resolution: "pending",
        });
      }
      operations.push({ type: "modified", heading: heading.text, rfc: rfcId });
    } else {
      operations.push({ type: "added", heading: heading.text, rfc: rfcId });
    }
  }

  if (conflicts.length > 0) {
    const result: SpecLiveMergeResult = {
      command: "spec.live.merge",
      domain,
      operation: "modified",
      deltas: operations,
      conflicts,
      dryRun,
    };

    if (outputFormat === "pretty") {
      logger.error(
        `spec.live.merge: ${conflicts.length} conflict(s) detected — merge aborted (all-or-nothing)`,
      );
      for (const c of conflicts) {
        logger.error(`  conflict: heading "${c.heading}" last modified by ${c.existingRfc}, now ${c.newRfc}`);
      }
    }

    return {
      data: result,
      exitCode: 1,
      summary: `spec.live.merge: ${conflicts.length} conflict(s) — merge aborted`,
    };
  }

  const updatedBody = applyDeltasToSpecBody(existingSpec.body, rfcHeadings, operations);

  const updatedSpec: LivingSpec = {
    ...existingSpec,
    lastMergedRfc: rfcId,
    updatedAt: today,
    history: [
      ...existingSpec.history,
      { rfc: rfcId, mergedAt: today, operation: "modified" },
    ],
    body: updatedBody,
  };

  if (!dryRun) {
    await writeFileIfChanged(specFilePath, serializeLivingSpec(updatedSpec));
  }

  const result: SpecLiveMergeResult = {
    command: "spec.live.merge",
    domain,
    operation: "modified",
    deltas: operations,
    conflicts: [],
    dryRun,
  };

  if (outputFormat === "pretty") {
    logger.success(
      `spec.live.merge: modified living spec for domain "${domain}" from ${rfcId} (${operations.length} deltas)${dryRun ? " [dry-run]" : ""}`,
    );
  }

  return { data: result, exitCode: 0, summary: `spec.live.merge: modified ${domain} from ${rfcId}` };
}
