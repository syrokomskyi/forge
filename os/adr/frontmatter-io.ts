/*
<MODULE_CONTRACT>
<purpose>
Shared ADR frontmatter file I/O — list ADR files and parse their YAML frontmatter
without validating the shape.
</purpose>
<non-goals>
  <item>Do not validate frontmatter shape — that is the validate handler.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0366: mirror the RFC frontmatter-io contract for ADRs.</item>
  <item>RFC-0521: migrated from packages/os/site-kernel/src/adr/ to packages/forge/os/adr/.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export interface ParsedAdr {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseAdrFile(source: string): ParsedAdr {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  return {
    frontmatter: (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

export async function listAdrFiles(adrDirPath: string): Promise<string[]> {
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
          !entry.name.startsWith("adr-0000") &&
          entry.name !== "README.md"
        ) {
          results.push(relativePath);
        }
      }
    } catch {
      // Directory doesn't exist or is unreadable — return empty
    }
  }

  await scanDir(adrDirPath, "");
  return results.sort();
}

export function adrFileMatchesId(fileName: string, targetId: string): boolean {
  return path.basename(fileName).toLowerCase().startsWith(targetId.toLowerCase());
}

export async function readAndParseAdr(
  adrDirPath: string,
  fileName: string,
): Promise<{ fileName: string; parsed: ParsedAdr } | undefined> {
  try {
    const filePath = path.join(adrDirPath, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    return { fileName, parsed: parseAdrFile(content) };
  } catch {
    return undefined;
  }
}
