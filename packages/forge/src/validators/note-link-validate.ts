/*
<MODULE_CONTRACT>
<purpose>Validate wikilink integrity across an Obsidian vault — scans [[wikilinks]] and resolves each against the note graph.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not implement domain-specific logic beyond wikilink resolution.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial note.link.validate command handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ForgeCommandResult } from "../types.ts";

interface NoteLinkValidateInput {
  flags: Record<string, unknown>;
}

export interface NoteLinkViolation {
  file: string;
  line: number;
  link: string;
  rule: "NOTE-01";
  message: string;
}

export interface NoteLinkValidateResult {
  command: "note.link.validate";
  violations: NoteLinkViolation[];
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

export function runNoteLinkValidate(
  input: NoteLinkValidateInput,
  context: { workspaceRoot?: string },
): ForgeCommandResult<NoteLinkValidateResult> {
  const workspaceRoot = context.workspaceRoot ?? process.cwd();
  const vaultDir = (input.flags["vault-dir"] as string) ?? "vault";
  const pathFilter = input.flags["path"] as string | undefined;
  const scanDir = pathFilter
    ? path.join(workspaceRoot, vaultDir, pathFilter)
    : path.join(workspaceRoot, vaultDir);

  if (!fs.existsSync(scanDir)) {
    return {
      data: {
        command: "note.link.validate",
        violations: [],
        count: 0,
      },
      exitCode: 0,
      summary: "note.link.validate: vault directory not found — 0 violations",
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

  const linkRegex = /\[\[([^\]]+?)\]\]/g;
  const violations: NoteLinkViolation[] = [];

  for (const file of allMdFiles) {
    const fullPath = path.join(workspaceRoot, file);
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        let match: RegExpExecArray | null;
        linkRegex.lastIndex = 0;
        while ((match = linkRegex.exec(lines[i])) !== null) {
          const linkTarget = match[1].split("|")[0].split("#")[0].trim();
          if (!linkTarget) continue;
          if (!noteMap.has(linkTarget)) {
            violations.push({
              file,
              line: i + 1,
              link: match[0],
              rule: "NOTE-01",
              message: `Wikilink target '${linkTarget}' not found in vault`,
            });
          }
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return {
    data: {
      command: "note.link.validate",
      violations,
      count: violations.length,
    },
    exitCode: violations.length > 0 ? 1 : 0,
    summary:
      violations.length > 0
        ? `note.link.validate: ${violations.length} violation(s) found`
        : "note.link.validate: OK — 0 violations",
  };
}
