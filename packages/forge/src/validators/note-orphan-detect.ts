/*
<MODULE_CONTRACT>
<purpose>Detect orphan notes in an Obsidian vault — notes with zero inbound wikilinks.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not implement domain-specific logic beyond orphan detection.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial note.orphan.detect command handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ForgeCommandResult } from "../types.ts";

interface NoteOrphanDetectInput {
  flags: Record<string, unknown>;
}

export interface OrphanReport {
  file: string;
  inboundLinks: 0;
  severity: "warning";
}

export interface NoteOrphanDetectResult {
  command: "note.orphan.detect";
  orphans: OrphanReport[];
  count: number;
}

function collectMarkdownFiles(dir: string, baseDir: string, results: string[]): void {
  const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", "dist", ".cache", ".obsidian"]);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      collectMarkdownFiles(fullPath, baseDir, results);
    } else if (entry.name.endsWith(".md")) {
      results.push(relPath);
    }
  }
}

export function runNoteOrphanDetect(
  input: NoteOrphanDetectInput,
  context: { workspaceRoot?: string },
): ForgeCommandResult<NoteOrphanDetectResult> {
  const workspaceRoot = context.workspaceRoot ?? process.cwd();
  const vaultDir = (input.flags["vault-dir"] as string) ?? "vault";
  const scanDir = path.join(workspaceRoot, vaultDir);

  if (!fs.existsSync(scanDir)) {
    return {
      data: {
        command: "note.orphan.detect",
        orphans: [],
        count: 0,
      },
      exitCode: 0,
      summary: "note.orphan.detect: vault directory not found — 0 orphans",
    };
  }

  const allMdFiles: string[] = [];
  collectMarkdownFiles(scanDir, workspaceRoot, allMdFiles);

  const noteMap = new Map<string, string>();
  for (const mdFile of allMdFiles) {
    const basename = path.basename(mdFile, ".md");
    noteMap.set(basename, mdFile);
    const fullPath = path.join(workspaceRoot, mdFile);
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        try {
          const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
          if (fm.aliases && Array.isArray(fm.aliases)) {
            for (const alias of fm.aliases) {
              if (typeof alias === "string") noteMap.set(alias, mdFile);
            }
          }
        } catch {
          // skip malformed frontmatter
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  const inboundLinks = new Map<string, number>();
  for (const mdFile of allMdFiles) {
    inboundLinks.set(mdFile, 0);
  }

  const linkRegex = /\[\[([^\]]+?)\]\]/g;
  for (const file of allMdFiles) {
    const fullPath = path.join(workspaceRoot, file);
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      let match: RegExpExecArray | null;
      linkRegex.lastIndex = 0;
      while ((match = linkRegex.exec(content)) !== null) {
        const linkTarget = match[1].split("|")[0].split("#")[0].trim();
        if (!linkTarget) continue;
        const targetFile = noteMap.get(linkTarget);
        if (targetFile && targetFile !== file) {
          inboundLinks.set(targetFile, (inboundLinks.get(targetFile) ?? 0) + 1);
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  const orphans: OrphanReport[] = [];
  for (const [file, count] of inboundLinks) {
    if (count === 0) {
      orphans.push({
        file,
        inboundLinks: 0,
        severity: "warning",
      });
    }
  }

  return {
    data: {
      command: "note.orphan.detect",
      orphans,
      count: orphans.length,
    },
    exitCode: 0,
    summary:
      orphans.length > 0
        ? `note.orphan.detect: ${orphans.length} orphan(s) found`
        : "note.orphan.detect: OK — 0 orphans",
  };
}
