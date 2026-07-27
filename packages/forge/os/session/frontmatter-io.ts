/*
<MODULE_CONTRACT>
<purpose>
Session frontmatter file I/O — recursive file discovery and YAML frontmatter
parsing for session files under docs/sessions/. Excludes .raw/ and archive/
subdirectories from the main file list.
</purpose>
<non-goals>
  <item>Do not validate session content — that is the validate handler.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: initial session frontmatter I/O.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { SESSION_FILE_PATTERN, SESSION_RAW_SUBDIR, SESSION_ARCHIVE_SUBDIR } from "./types.ts";

export interface ParsedSession {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSessionFile(source: string): ParsedSession {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: source };
  }
  return {
    frontmatter: (YAML.parse(match[1]!) ?? {}) as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

/**
 * List all .md session files in the session directory, excluding the .raw/
 * and archive/ subdirectories. Returns relative paths sorted alphabetically.
 */
export async function listSessionFiles(sessionDirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function scanDir(dirPath: string, relativePrefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === SESSION_RAW_SUBDIR || entry.name === SESSION_ARCHIVE_SUBDIR) {
        continue;
      }
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await scanDir(path.join(dirPath, entry.name), relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "README.md" &&
        SESSION_FILE_PATTERN.test(entry.name)
      ) {
        results.push(relativePath);
      }
    }
  }

  await scanDir(sessionDirPath, "");
  return results.sort();
}

/**
 * List all .md session files in the archive/ subdirectory.
 * Returns relative paths (relative to sessionDirPath) sorted alphabetically.
 */
export async function listArchivedSessionFiles(sessionDirPath: string): Promise<string[]> {
  const archiveDirPath = path.join(sessionDirPath, SESSION_ARCHIVE_SUBDIR);
  const results: string[] = [];

  async function scanDir(dirPath: string, relativePrefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await scanDir(path.join(dirPath, entry.name), relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        SESSION_FILE_PATTERN.test(entry.name)
      ) {
        results.push(relativePath);
      }
    }
  }

  await scanDir(archiveDirPath, "");
  return results.sort();
}

export async function readAndParseSession(
  sessionDirPath: string,
  fileName: string,
): Promise<{ fileName: string; parsed: ParsedSession } | undefined> {
  try {
    const filePath = path.join(sessionDirPath, fileName);
    const content = await fs.readFile(filePath, "utf-8");
    return { fileName, parsed: parseSessionFile(content) };
  } catch {
    return undefined;
  }
}

/**
 * List all files (including non-.md) directly in the session directory root,
 * excluding .raw/ and archive/ subdirectories. Used by SES-05 to detect
 * non-markdown files.
 */
export async function listNonMarkdownSessionFiles(sessionDirPath: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(sessionDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        !entry.name.endsWith(".md") &&
        entry.name !== ".gitkeep" &&
        entry.name !== "README.md"
      ) {
        results.push(entry.name);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return results;
}

/**
 * List all files in the .raw/ subdirectory. Used by SES-04 to detect
 * raw files that should have been processed.
 */
export async function listRawFiles(sessionDirPath: string): Promise<string[]> {
  const rawDirPath = path.join(sessionDirPath, SESSION_RAW_SUBDIR);
  const results: string[] = [];
  try {
    const entries = await fs.readdir(rawDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        results.push(entry.name);
      }
    }
  } catch {
    // .raw/ doesn't exist — that's fine
  }
  return results;
}
