/*
<MODULE_CONTRACT>
<purpose>
Shared exploration note frontmatter I/O — list exploration files and parse
their YAML frontmatter without validating the shape.
</purpose>
<non-goals>
  <item>Do not validate frontmatter shape — that is the skill's responsibility.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0710: initial exploration frontmatter I/O.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { EXPLORATION_DIR } from "./types.ts";

export interface ParsedExplorationNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseExplorationFile(source: string): ParsedExplorationNote {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  return {
    frontmatter: (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

export async function listExplorationFiles(explorationsDirPath: string): Promise<string[]> {
  const results: string[] = [];

  try {
    const entries = await fs.readdir(explorationsDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
        results.push(entry.name);
      }
    }
  } catch {
    // Directory doesn't exist or is unreadable — return empty
  }

  return results.sort();
}

export async function readAndParseExplorationNote(
  explorationsDirPath: string,
  fileName: string,
): Promise<{ fileName: string; parsed: ParsedExplorationNote } | undefined> {
  try {
    const filePath = path.join(explorationsDirPath, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    return { fileName, parsed: parseExplorationFile(content) };
  } catch {
    return undefined;
  }
}

export function serializeExplorationNote(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const fmYaml = YAML.stringify(frontmatter).trimEnd();
  return `---\n${fmYaml}\n---\n${body}`;
}

export function getExplorationsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, EXPLORATION_DIR);
}
