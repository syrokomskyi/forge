/*
<MODULE_CONTRACT>
<purpose>
session.save handler — converts raw ATIF files from docs/sessions/.raw/ to
structured markdown in docs/sessions/ with auto-extracted metadata.
Deterministic only — no LLM/intelligent annotation (that is fo-session-save skill).
</purpose>
<non-goals>
  <item>Does not generate semantic summaries or decisions — that is the fo-session-save skill.</item>
  <item>Does not archive sessions — that is session.archive.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: implement session.save command handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { parseAtif, messagesToTranscriptMarkdown } from "../atif-parser.ts";
import { trashPath } from "../../../src/utils/fs-trash.ts";
import {
  SESSION_DIR,
  SESSION_RAW_SUBDIR,
  type SessionType,
  type SessionSaveResult,
  type SessionSaveSkip,
} from "../types.ts";

const RFC_PATTERN = /\bRFC-\d{4}\b/g;
const FILE_PATH_PATTERN = /\b(?:packages|docs|services|systems|tools|scripts)\/[^\s"'`<>|]+/g;
const COMMIT_HASH_PATTERN = /\b[0-9a-f]{7,40}\b/g;
const COMMAND_PATTERN =
  /\b(?:session|rfc|adr|plan|audit|docs|mission|forge|compass|werkstatt|spec|naming|workflow|bordbuch|sternsystem|release)\.\w+/g;

const TYPE_INDICATORS: Array<{ type: SessionType; patterns: RegExp[] }> = [
  { type: "grilling", patterns: [/grilling/i, /\/grilling/i, /fo-idea.*plan/i] },
  {
    type: "mission",
    patterns: [/mission\.open/i, /mission\.materialize/i, /mission\.reconcile/i, /mission\.close/i],
  },
  {
    type: "implementation",
    patterns: [/rfc\.implement\.stamp/i, /implement:\s/i, /fo-idea-implement/i],
  },
  { type: "review", patterns: [/fo-review/i, /review:\s/i] },
  { type: "fix", patterns: [/fo-fix/i, /fix:\s/i] },
];

function extractRfcIds(content: string): string[] {
  const matches = content.match(RFC_PATTERN);
  return matches ? [...new Set(matches)] : [];
}

function extractFilePaths(content: string): string[] {
  const matches = content.match(FILE_PATH_PATTERN);
  return matches ? [...new Set(matches)] : [];
}

function extractCommitHashes(content: string): string[] {
  const matches = content.match(COMMIT_HASH_PATTERN);
  if (!matches) return [];
  // Filter to plausible git hashes (7-40 hex chars, but exclude pure version numbers)
  const filtered = matches.filter((h) => {
    // Exclude strings that look like version numbers (e.g. 1.0.0)
    if (/^\d+$/.test(h) && h.length <= 8) return false;
    return true;
  });
  return [...new Set(filtered)];
}

function extractCommands(content: string): string[] {
  const matches = content.match(COMMAND_PATTERN);
  return matches ? [...new Set(matches)] : [];
}

function detectSessionTypes(content: string): SessionType[] {
  const detected: SessionType[] = [];
  for (const { type, patterns } of TYPE_INDICATORS) {
    if (patterns.some((p) => p.test(content))) {
      detected.push(type);
    }
  }
  if (detected.length === 0) {
    return ["freeform"];
  }
  return detected;
}

function computeSessionId(rawContent: string, timestamp: Date): string {
  const hash = createHash("sha256").update(rawContent).digest("hex").slice(0, 6);
  const parts = [
    timestamp.getFullYear(),
    String(timestamp.getMonth() + 1).padStart(2, "0"),
    String(timestamp.getDate()).padStart(2, "0"),
    String(timestamp.getHours()).padStart(2, "0"),
    String(timestamp.getMinutes()).padStart(2, "0"),
    String(timestamp.getSeconds()).padStart(2, "0"),
  ];
  return `${parts.join("-")}-${hash}`;
}

function extractTimestampFromContent(content: string): Date | null {
  // Try to find an ISO 8601 timestamp in the content
  const isoMatch = content.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?/);
  if (isoMatch) {
    const date = new Date(isoMatch[0].replace(" ", "T"));
    if (!isNaN(date.getTime())) return date;
  }
  // Try date-only
  const dateMatch = content.match(/\d{4}-\d{2}-\d{2}/);
  if (dateMatch) {
    const date = new Date(dateMatch[0] + "T00:00:00");
    if (!isNaN(date.getTime())) return date;
  }
  return null;
}

function buildSessionMarkdown(
  id: string,
  timestamp: Date,
  types: SessionType[],
  metadata: {
    relatedRfcs: string[];
    relatedArtifacts: string[];
    commits: string[];
    files: string[];
    commands: string[];
  },
  transcriptMarkdown: string,
): string {
  const isoDate = timestamp.toISOString();
  const frontmatter: Record<string, unknown> = {
    id,
    date: isoDate,
    duration: null,
    types,
    summary: "",
    relatedRfcs: metadata.relatedRfcs,
    relatedArtifacts: metadata.relatedArtifacts,
    decisions: [],
    commits: metadata.commits,
    files: metadata.files,
    commands: metadata.commands,
  };

  const yamlStr = YAML.stringify(frontmatter, { lineWidth: 0 });
  return `---\n${yamlStr}---\n\n# Session: ${id}\n\n## Transcript\n\n${transcriptMarkdown}\n`;
}

export async function runSessionSave(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SessionSaveResult & { skipped: SessionSaveSkip[] }>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const sessionDirPath = path.join(workspaceRoot, SESSION_DIR);
  const rawDirPath = path.join(sessionDirPath, SESSION_RAW_SUBDIR);

  const dryRun = context.dryRun || input.flags["dry-run"] === true;
  const keepRaw = input.flags["keep-raw"] === true;
  const rawFileFlag = input.flags["raw-file"] as string | undefined;

  // Determine which raw files to process
  let rawFiles: string[];
  if (rawFileFlag) {
    const resolvedPath = path.isAbsolute(rawFileFlag)
      ? rawFileFlag
      : path.join(workspaceRoot, rawFileFlag);
    try {
      await fs.access(resolvedPath);
    } catch {
      throw new Error(`Raw file not found: ${rawFileFlag}`);
    }
    rawFiles = [
      path.isAbsolute(rawFileFlag)
        ? path.relative(rawDirPath, resolvedPath)
        : rawFileFlag.replace(`${SESSION_DIR}/${SESSION_RAW_SUBDIR}/`, ""),
    ];
  } else {
    try {
      const entries = await fs.readdir(rawDirPath, { withFileTypes: true });
      rawFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      rawFiles = [];
    }
  }

  if (rawFiles.length === 0) {
    if (outputFormat === "pretty") {
      logger.info("No raw files to process.");
    }
    return {
      data: {
        command: "session.save",
        status: "ok",
        file: "",
        rawFile: "",
        rawDeleted: false,
        id: "",
        types: [],
        extractedMetadata: {
          relatedRfcs: [],
          relatedArtifacts: [],
          commits: [],
          files: [],
          commands: [],
        },
        dryRun,
        skipped: [],
      },
      summary: "No raw files to process",
    };
  }

  const saved: SessionSaveResult[] = [];
  const skipped: SessionSaveSkip[] = [];

  for (const rawFileName of rawFiles) {
    const rawFilePath = path.join(rawDirPath, rawFileName);
    let rawContent: string;
    try {
      rawContent = await fs.readFile(rawFilePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        skipped.push({ rawFile: rawFileName, reason: "already processed by another process" });
        continue;
      }
      throw err;
    }

    // Parse ATIF
    const atifResult = parseAtif(rawContent);
    const transcriptText = messagesToTranscriptMarkdown(atifResult.messages);

    // Extract metadata
    const fullContent = rawContent;
    const relatedRfcs = extractRfcIds(fullContent);
    const relatedArtifacts = extractFilePaths(fullContent);
    const commits = extractCommitHashes(fullContent);
    const files = extractFilePaths(fullContent);
    const commands = extractCommands(fullContent);
    const types = detectSessionTypes(fullContent);

    // Compute session id
    const extractedTimestamp = extractTimestampFromContent(fullContent);
    const timestamp = extractedTimestamp ?? new Date();
    const id = computeSessionId(rawContent, timestamp);

    // Check if output already exists (idempotency)
    const outputFileName = `${id}.md`;
    const outputPath = path.join(sessionDirPath, outputFileName);
    const outputRel = path.join(SESSION_DIR, outputFileName);

    try {
      await fs.access(outputPath);
      skipped.push({ rawFile: rawFileName, reason: "already converted" });
      if (outputFormat === "pretty") {
        logger.info(`Skipped ${rawFileName}: already converted to ${outputRel}`);
      }
      continue;
    } catch {
      // Output doesn't exist — proceed
    }

    // Build markdown
    const markdown = buildSessionMarkdown(
      id,
      timestamp,
      types,
      { relatedRfcs, relatedArtifacts, commits, files, commands },
      transcriptText,
    );

    if (!dryRun) {
      await fs.mkdir(sessionDirPath, { recursive: true });
      await fs.writeFile(outputPath, markdown, "utf-8");

      // Delete raw file unless --keep-raw
      if (!keepRaw) {
        try {
          await trashPath(rawFilePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
      }
    }

    const result: SessionSaveResult = {
      command: "session.save",
      status: "ok",
      file: outputRel,
      rawFile: path.join(SESSION_DIR, SESSION_RAW_SUBDIR, rawFileName),
      rawDeleted: !dryRun && !keepRaw,
      id,
      types,
      extractedMetadata: {
        relatedRfcs,
        relatedArtifacts,
        commits,
        files,
        commands,
      },
      dryRun,
    };
    saved.push(result);

    if (outputFormat === "pretty") {
      logger.success(`Saved session ${id} to ${outputRel}`);
    }
  }

  const firstSaved = saved[0];
  return {
    data: firstSaved
      ? { ...firstSaved, skipped }
      : {
          command: "session.save" as const,
          status: "ok" as const,
          file: "",
          rawFile: "",
          rawDeleted: false,
          id: "",
          types: [],
          extractedMetadata: {
            relatedRfcs: [],
            relatedArtifacts: [],
            commits: [],
            files: [],
            commands: [],
          },
          dryRun,
          skipped,
        },
    summary: dryRun
      ? `[dry-run] Would save ${saved.length} session(s), skip ${skipped.length}`
      : `Saved ${saved.length} session(s), skipped ${skipped.length}`,
  };
}
