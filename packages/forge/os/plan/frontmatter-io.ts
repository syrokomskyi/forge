/*
<MODULE_CONTRACT>
<purpose>
Plan frontmatter file I/O — recursive file discovery and YAML frontmatter
parsing for plan files under docs/plans/.
</purpose>
<non-goals>
  <item>Do not validate plan content — that is a future concern.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: initial plan frontmatter I/O.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { PLAN_FILE_PATTERN } from "./types.ts";

export interface ParsedPlan {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parsePlanFile(source: string): ParsedPlan {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  return {
    frontmatter: (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

export async function listPlanFiles(planDirPath: string): Promise<string[]> {
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
          !entry.name.startsWith("plan-0000") &&
          entry.name !== "README.md" &&
          PLAN_FILE_PATTERN.test(entry.name)
        ) {
          results.push(relativePath);
        }
      }
    } catch {
      // Directory doesn't exist or is unreadable — return empty
    }
  }

  await scanDir(planDirPath, "");
  return results.sort();
}

export async function readAndParsePlan(
  planDirPath: string,
  fileName: string,
): Promise<{ fileName: string; parsed: ParsedPlan } | undefined> {
  try {
    const filePath = path.join(planDirPath, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    return { fileName, parsed: parsePlanFile(content) };
  } catch {
    return undefined;
  }
}

export function extractRfcIdFromPlanFile(fileName: string): string | undefined {
  const match = path.basename(fileName).match(/^plan-(rfc-\d{4})-/i);
  return match ? match[1]!.toUpperCase() : undefined;
}
