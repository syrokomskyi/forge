/*
<MODULE_CONTRACT>
<purpose>
Audit frontmatter file I/O — recursive file discovery and YAML frontmatter
parsing for audit files under docs/audits/. Only files matching the
audit-rfc-XXXX-* pattern are candidates for archiving; standalone audits
are silently excluded.
</purpose>
<non-goals>
  <item>Do not validate audit content.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: initial audit frontmatter I/O.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { AUDIT_RFC_FILE_PATTERN } from "./types.ts";

export interface ParsedAudit {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseAuditFile(source: string): ParsedAudit {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  return {
    frontmatter: (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

export async function listAuditFiles(auditDirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function scanDir(dirPath: string, relativePrefix: string): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = relativePrefix
          ? `${relativePrefix}/${entry.name}`
          : entry.name;
        if (entry.isDirectory()) {
          await scanDir(path.join(dirPath, entry.name), relativePath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          !entry.name.startsWith("audit-0000") &&
          entry.name !== "README.md" &&
          AUDIT_RFC_FILE_PATTERN.test(entry.name)
        ) {
          results.push(relativePath);
        }
      }
    } catch {
      // Directory doesn't exist or is unreadable — return empty
    }
  }

  await scanDir(auditDirPath, "");
  return results.sort();
}

export async function readAndParseAudit(
  auditDirPath: string,
  fileName: string,
): Promise<{ fileName: string; parsed: ParsedAudit } | undefined> {
  try {
    const filePath = path.join(auditDirPath, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    return { fileName, parsed: parseAuditFile(content) };
  } catch {
    return undefined;
  }
}

export function extractRfcIdFromAuditFile(fileName: string): string | undefined {
  const match = path.basename(fileName).match(/^audit-(rfc-\d{4})-/i);
  return match ? match[1]!.toUpperCase() : undefined;
}
