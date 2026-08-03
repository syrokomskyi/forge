/*
<MODULE_CONTRACT>
<purpose>Tolerant markdown parser for knowledge files — produces ParsedKnowledgeFile with entries, legacy sections, and parse issues (RFC-0660).</purpose>
<non-goals>
  <item>Do not validate entry uniqueness or cross-references — that is handled by SKILL-20 in skill-validate.ts.</item>
  <item>Do not serialize — that is handled by serialize.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0660: initial tolerant parser for structured knowledge entries.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  knowledgeEntryMetaSchema,
  type KnowledgeLayer,
  type KnowledgeEntry,
  type KnowledgeEntryMeta,
  type LegacySection,
  type ParseIssue,
  type ParsedKnowledgeFile,
} from "./schema.ts";

const ENTRY_HEADING_PATTERN = /^###\s+(K-\d{4})\s*:\s*(.+)$/;
const KNOWLEDGE_ENTRY_FENCE = "knowledge-entry";
const LAYER_COMMENT_PATTERN = /<!--\s*knowledge-layer:\s*(L[012])\s*-->/;

const FILENAME_LAYER_MAP: Record<string, KnowledgeLayer> = {
  "qa-log.md": "L0",
  "fix-patterns.md": "L1",
  "learned-principles.md": "L2",
};

function detectLayer(
  content: string,
  fileName: string,
): KnowledgeLayer | null {
  const commentMatch = content.match(LAYER_COMMENT_PATTERN);
  if (commentMatch) {
    return commentMatch[1] as KnowledgeLayer;
  }
  return FILENAME_LAYER_MAP[fileName] ?? null;
}

export function parseKnowledgeFile(filePath: string): ParsedKnowledgeFile {
  const content = fs.readFileSync(filePath, "utf-8");
  const fileName = path.basename(filePath);
  const lines = content.split(/\r?\n/);
  const layer = detectLayer(content, fileName);

  const entries: KnowledgeEntry[] = [];
  const legacySections: LegacySection[] = [];
  const parseIssues: ParseIssue[] = [];

  let i = 0;
  let preambleEnd = 0;

  // Find the first entry heading or the first non-preamble content
  let firstEntryLine = -1;
  for (let j = 0; j < lines.length; j++) {
    if (ENTRY_HEADING_PATTERN.test(lines[j])) {
      firstEntryLine = j;
      break;
    }
  }

  // If no entry headings and no layer declaration, it's a knowledge-adjacent file
  const isKnowledgeAdjacent = firstEntryLine === -1 && layer === null;

  if (isKnowledgeAdjacent) {
    return {
      path: filePath,
      layer: null,
      preamble: content,
      entries: [],
      legacySections: [],
      parseIssues: [],
      isKnowledgeAdjacent: true,
    };
  }

  // Preamble is everything before the first entry heading
  if (firstEntryLine === -1) {
    // Has layer but no entries — all content is preamble (structured-empty file)
    return {
      path: filePath,
      layer,
      preamble: content,
      entries: [],
      legacySections: [],
      parseIssues: [],
      isKnowledgeAdjacent: false,
    };
  }

  preambleEnd = firstEntryLine;
  const preamble = lines.slice(0, preambleEnd).join("\n");

  // Parse entries and legacy sections
  i = preambleEnd;
  while (i < lines.length) {
    const headingMatch = lines[i].match(ENTRY_HEADING_PATTERN);

    if (headingMatch) {
      const entryId = headingMatch[1];
      const title = headingMatch[2].trim();
      const entryLineStart = i + 1; // 1-based
      i++;

      // Look for fenced knowledge-entry block immediately after heading
      let meta: KnowledgeEntryMeta | null = null;
      let metaBlockStart = -1;
      let metaBlockEnd = -1;

      // Skip blank lines between heading and fence
      while (i < lines.length && lines[i].trim() === "") {
        i++;
      }

      if (i < lines.length && lines[i].trim().startsWith("```")) {
        const fenceTag = lines[i].trim().replace(/^```/, "").trim();
        if (fenceTag === KNOWLEDGE_ENTRY_FENCE) {
          metaBlockStart = i + 1; // 1-based line after fence start
          i++;
          const yamlLines: string[] = [];
          while (i < lines.length && !lines[i].trim().startsWith("```")) {
            yamlLines.push(lines[i]);
            i++;
          }
          if (i < lines.length && lines[i].trim().startsWith("```")) {
            metaBlockEnd = i + 1; // 1-based fence closing line
            i++;

            const yamlText = yamlLines.join("\n");
            try {
              const raw = parseYaml(yamlText) as Record<string, unknown>;
              const result = knowledgeEntryMetaSchema.safeParse(raw);
              if (result.success) {
                meta = result.data as KnowledgeEntryMeta;
              } else {
                for (const issue of result.error.issues) {
                  parseIssues.push({
                    line: metaBlockStart,
                    message: `Entry ${entryId}: ${issue.message}`,
                    entryId,
                  });
                }
              }
            } catch (err) {
              parseIssues.push({
                line: metaBlockStart,
                message: `Entry ${entryId}: YAML parse error: ${(err as Error).message}`,
                entryId,
              });
            }
          } else {
            parseIssues.push({
              line: metaBlockStart,
              message: `Entry ${entryId}: unterminated knowledge-entry fence`,
              entryId,
            });
          }
        }
      }

      // Collect body until next entry heading or EOF
      const bodyLines: string[] = [];
      while (i < lines.length && !ENTRY_HEADING_PATTERN.test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }
      const body = bodyLines.join("\n").replace(/\n+$/, "");

      if (meta) {
        entries.push({
          meta,
          title,
          body,
          lineStart: entryLineStart,
        });
      } else if (metaBlockStart === -1) {
        // Heading exists but no metadata block followed — it's a legacy section
        legacySections.push({
          text: lines.slice(entryLineStart - 1, i).join("\n"),
          lineStart: entryLineStart,
        });
      }
      // If meta parsing failed, the parse issue is already recorded
    } else {
      // Non-entry content — collect as legacy section
      const legacyStart = i + 1; // 1-based
      const legacyLines: string[] = [];
      while (i < lines.length && !ENTRY_HEADING_PATTERN.test(lines[i])) {
        legacyLines.push(lines[i]);
        i++;
      }
      legacySections.push({
        text: legacyLines.join("\n"),
        lineStart: legacyStart,
      });
    }
  }

  return {
    path: filePath,
    layer,
    preamble,
    entries,
    legacySections,
    parseIssues,
    isKnowledgeAdjacent: false,
  };
}
