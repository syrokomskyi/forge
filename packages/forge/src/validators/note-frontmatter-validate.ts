/*
<MODULE_CONTRACT>
<purpose>Validate frontmatter consistency across an Obsidian vault — checks for required fields in YAML frontmatter.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not implement domain-specific logic beyond frontmatter validation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial note.frontmatter.validate command handler.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ForgeCommandResult } from "../types.ts";

interface NoteFrontmatterValidateInput {
  flags: Record<string, unknown>;
}

export interface FrontmatterViolation {
  file: string;
  field: string;
  rule: "NOTE-02";
  message: string;
}

export interface NoteFrontmatterValidateResult {
  command: "note.frontmatter.validate";
  violations: FrontmatterViolation[];
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

export function runNoteFrontmatterValidate(
  input: NoteFrontmatterValidateInput,
  context: { workspaceRoot?: string },
): ForgeCommandResult<NoteFrontmatterValidateResult> {
  const workspaceRoot = context.workspaceRoot ?? process.cwd();
  const vaultDir = (input.flags["vault-dir"] as string) ?? "vault";
  const requiredFields = ((input.flags["fields"] as string) ?? "title")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  const scanDir = path.join(workspaceRoot, vaultDir);

  if (!fs.existsSync(scanDir)) {
    return {
      data: {
        command: "note.frontmatter.validate",
        violations: [],
        count: 0,
      },
      exitCode: 0,
      summary: "note.frontmatter.validate: vault directory not found — 0 violations",
    };
  }

  const allMdFiles: string[] = [];
  collectMarkdownFiles(scanDir, workspaceRoot, allMdFiles);

  const violations: FrontmatterViolation[] = [];

  for (const file of allMdFiles) {
    const fullPath = path.join(workspaceRoot, file);
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) {
        for (const field of requiredFields) {
          violations.push({
            file,
            field,
            rule: "NOTE-02",
            message: `File '${file}' has no frontmatter — missing field '${field}'`,
          });
        }
        continue;
      }
      let fm: Record<string, unknown> = {};
      try {
        fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
      } catch {
        for (const field of requiredFields) {
          violations.push({
            file,
            field,
            rule: "NOTE-02",
            message: `File '${file}' has malformed frontmatter — missing field '${field}'`,
          });
        }
        continue;
      }
      for (const field of requiredFields) {
        if (!(field in fm) || fm[field] == null || fm[field] === "") {
          if (field === "title") {
            const hasH1 = /^\s*#\s+\S/.test(content.slice(fmMatch[0].length));
            if (hasH1) continue;
          }
          violations.push({
            file,
            field,
            rule: "NOTE-02",
            message: `File '${file}' missing required field '${field}'`,
          });
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return {
    data: {
      command: "note.frontmatter.validate",
      violations,
      count: violations.length,
    },
    exitCode: violations.length > 0 ? 1 : 0,
    summary:
      violations.length > 0
        ? `note.frontmatter.validate: ${violations.length} violation(s) found`
        : "note.frontmatter.validate: OK — 0 violations",
  };
}
