/*
<MODULE_CONTRACT>
<purpose>
Shared RFC frontmatter file I/O — extracted from handlers.ts so both
handlers.ts and acceptance.ts (RFC-0268) can read RFC files without a
circular import between the two.
</purpose>
<non-goals>
  <item>Do not validate frontmatter shape — that is handlers.ts / acceptance.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0268: extracted from handlers.ts to break a circular import with acceptance.ts.</item>
  <item>Post-refactor hardening: added basename-based RFC id matching for archived RFC paths.</item>
  <item>RFC-0521: added getRfcStatusById and loadRfcStatusMap helpers for plan/audit archive commands.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export interface ParsedRfc {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseRfcFile(source: string): ParsedRfc {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  return {
    frontmatter: (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

export async function listRfcFiles(rfcDirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function scanDir(dirPath: string, relativePrefix: string): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await scanDir(path.join(dirPath, entry.name), relativePath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          !entry.name.startsWith("rfc-0000") &&
          entry.name !== "README.md"
        ) {
          results.push(relativePath);
        }
      }
    } catch {
      // Directory doesn't exist or is unreadable — return empty
    }
  }

  await scanDir(rfcDirPath, "");
  return results.sort();
}

export function rfcFileMatchesId(fileName: string, targetId: string): boolean {
  return path.basename(fileName).toLowerCase().startsWith(targetId.toLowerCase());
}

export async function readAndParseRfc(
  rfcDirPath: string,
  fileName: string,
): Promise<{ fileName: string; parsed: ParsedRfc } | undefined> {
  try {
    const filePath = path.join(rfcDirPath, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    return { fileName, parsed: parseRfcFile(content) };
  } catch {
    return undefined;
  }
}

export async function getRfcStatusById(
  rfcDirPath: string,
  rfcId: string,
): Promise<string | undefined> {
  const files = await listRfcFiles(rfcDirPath);
  for (const fileName of files) {
    if (rfcFileMatchesId(fileName, rfcId)) {
      const parsed = await readAndParseRfc(rfcDirPath, fileName);
      if (parsed) {
        const status = String(parsed.parsed.frontmatter["status"] ?? "").trim();
        if (status) return status;
      }
    }
  }
  return undefined;
}

export async function loadRfcStatusMap(rfcDirPath: string): Promise<Map<string, string>> {
  const files = await listRfcFiles(rfcDirPath);
  const statusMap = new Map<string, string>();
  for (const fileName of files) {
    const parsed = await readAndParseRfc(rfcDirPath, fileName);
    if (parsed) {
      const id = String(parsed.parsed.frontmatter["id"] ?? "").trim();
      const status = String(parsed.parsed.frontmatter["status"] ?? "").trim();
      if (id && status) {
        statusMap.set(id, status);
      }
    }
  }
  return statusMap;
}
