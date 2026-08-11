/*
<MODULE_CONTRACT>
<purpose>Generic invariant enforcement engine — reads check declarations from profile invariants and verifies files against them. Supports filename-pattern, file-contains, file-not-contains, and attribute-pattern check kinds.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not implement domain-specific validation logic — all rules are declared in profile YAML.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0675: initial invariant enforcement engine with three check kinds.</item>
  <item>RFC-0691: add html-attribute-pattern check kind for HTML attribute value validation.</item>
  <item>RFC-0694: replace html-attribute-pattern with attribute-pattern (elements array) for HTML+JSX support.</item>
  <item>RFC-0808: add link-resolution, frontmatter-required, path-exclusion check kinds for obsidian-vault profile.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { StackProfile } from "../profiles/stack-profile.ts";
import type { ProfileInvariant } from "../profiles/profile-schema.ts";

export interface InvariantViolation {
  invariantId: string;
  severity: "error" | "warning";
  rule: string;
  file: string;
  message: string;
}

export interface InvariantCheckResult {
  invariantId: string;
  severity: "error" | "warning";
  rule: string;
  checked: boolean;
  violations: InvariantViolation[];
}

function matchGlob(filePath: string, glob: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const globRegex = globToRegex(glob);
  return globRegex.test(normalizedPath);
}

function globToRegex(glob: string): RegExp {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Handle **/ : matches zero or more directory segments
  pattern = pattern.replace(/\*\*\//g, "@@GLOBSTAR@@");
  // Handle remaining ** (not followed by /)
  pattern = pattern.replace(/\*\*/g, "@@GLOBSTAR2@@");
  // Handle single * (matches within a path segment, no /)
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/\?/g, "[^/]");
  // Restore globstars
  pattern = pattern.replace(/@@GLOBSTAR@@/g, "(?:[^/]+/)*");
  pattern = pattern.replace(/@@GLOBSTAR2@@/g, ".*");
  // Handle brace expansion {a,b}
  pattern = pattern.replace(/\\{([^}]+)\\}/g, (_match, content: string) => {
    const options = content.split(",").map((s: string) => s.trim());
    return `(${options.join("|")})`;
  });
  pattern = `^${pattern}$`;
  return new RegExp(pattern);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", "dist", ".cache"]);

function collectFiles(dir: string, baseDir: string, results: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, results);
    } else {
      results.push(relPath);
    }
  }
}

function compilePattern(
  invariant: ProfileInvariant,
  pattern: string,
): RegExp | { error: InvariantViolation } {
  try {
    return new RegExp(pattern);
  } catch (err) {
    const e = err as Error;
    return {
      error: {
        invariantId: invariant.id,
        severity: "warning",
        rule: invariant.rule,
        file: "",
        message: `Invariant ${invariant.id} has invalid check pattern: ${e.message}`,
      },
    };
  }
}

function filterByGlob(files: string[], glob: string): string[] {
  return files.filter((f) => matchGlob(f, glob));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runCheck(
  invariant: ProfileInvariant,
  allFiles: string[],
  workspaceRoot: string,
  check: NonNullable<ProfileInvariant["check"]>,
): InvariantViolation[] {
  const glob = check.glob;
  if (!glob) return [];

  const matchedFiles = filterByGlob(allFiles, glob);

  const pattern = check.pattern ?? check.negatedPattern;
  const needsPattern = check.kind === "filename-pattern" ||
    check.kind === "file-contains" ||
    check.kind === "file-not-contains" ||
    check.kind === "attribute-pattern";
  if (needsPattern && !pattern) return [];

  const compiled = pattern ? compilePattern(invariant, pattern) : null;
  if (compiled && "error" in compiled) return [compiled.error];
  const regex = compiled && !("error" in compiled) ? compiled : null;

  const violations: InvariantViolation[] = [];

  switch (check.kind) {
    case "filename-pattern":
      for (const file of matchedFiles) {
        const filename = path.basename(file);
        if (!regex!.test(filename)) {
          violations.push({
            invariantId: invariant.id,
            severity: invariant.severity,
            rule: invariant.rule,
            file,
            message: `Filename '${filename}' does not match pattern '${pattern}'`,
          });
        }
      }
      break;
    case "file-contains":
      for (const file of matchedFiles) {
        const fullPath = path.join(workspaceRoot, file);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          if (!regex!.test(content)) {
            violations.push({
              invariantId: invariant.id,
              severity: invariant.severity,
              rule: invariant.rule,
              file,
              message: `File '${file}' does not contain pattern '${pattern}'`,
            });
          }
        } catch {
          // skip unreadable files
        }
      }
      break;
    case "file-not-contains":
      for (const file of matchedFiles) {
        const fullPath = path.join(workspaceRoot, file);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          if (regex!.test(content)) {
            violations.push({
              invariantId: invariant.id,
              severity: invariant.severity,
              rule: invariant.rule,
              file,
              message: `File '${file}' contains forbidden pattern '${pattern}'`,
            });
          }
        } catch {
          // skip unreadable files
        }
      }
      break;
    case "attribute-pattern": {
      const elements = check.elements;
      const attribute = check.attribute;
      if (!elements || elements.length === 0 || !attribute) {
        violations.push({
          invariantId: invariant.id,
          severity: "warning",
          rule: invariant.rule,
          file: "",
          message: `Invariant ${invariant.id} has attribute-pattern check without elements or attribute`,
        });
        break;
      }
      const elementAlternation = elements.map(escapeRegex).join("|");
      const elementRegex = new RegExp(`<(${elementAlternation})[^>]*>`, "gi");
      const attrRegex = new RegExp(
        `${attribute}="([^"]*)"|${attribute}='([^']*)'`,
        "i",
      );
      for (const file of matchedFiles) {
        const fullPath = path.join(workspaceRoot, file);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          elementRegex.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = elementRegex.exec(content)) !== null) {
            const elementSnippet = match[0];
            const matchedElement = match[1];
            const attrMatch = attrRegex.exec(elementSnippet);
            if (!attrMatch) continue;
            const attrValue = attrMatch[1] ?? attrMatch[2] ?? "";
            if (!regex!.test(attrValue)) {
              violations.push({
                invariantId: invariant.id,
                severity: invariant.severity,
                rule: invariant.rule,
                file,
                message: `Element <${matchedElement}> attribute '${attribute}' value '${attrValue}' does not match pattern '${pattern}'`,
              });
            }
          }
        } catch {
          // skip unreadable files
        }
      }
      break;
    }
    case "link-resolution": {
      const allMdFiles = allFiles.filter((f) => f.endsWith(".md"));
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
      for (const file of matchedFiles) {
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
                  invariantId: invariant.id,
                  severity: invariant.severity,
                  rule: invariant.rule,
                  file,
                  message: `Wikilink target '${linkTarget}' not found in vault`,
                });
              }
            }
          }
        } catch {
          // skip unreadable files
        }
      }
      break;
    }
    case "frontmatter-required": {
      const fields = check.fields;
      if (!fields || fields.length === 0) break;
      for (const file of matchedFiles) {
        const fullPath = path.join(workspaceRoot, file);
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (!fmMatch) {
            violations.push({
              invariantId: invariant.id,
              severity: invariant.severity,
              rule: invariant.rule,
              file,
              message: `File '${file}' has no frontmatter`,
            });
            break;
          }
          let fm: Record<string, unknown> = {};
          try {
            fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
          } catch {
            violations.push({
              invariantId: invariant.id,
              severity: invariant.severity,
              rule: invariant.rule,
              file,
              message: `File '${file}' has malformed frontmatter`,
            });
            break;
          }
          for (const field of fields) {
            if (!(field in fm) || fm[field] == null || fm[field] === "") {
              const hasH1 = /^\s*#\s+\S/.test(content.slice(fmMatch[0].length));
              if (field === "title" && hasH1) continue;
              violations.push({
                invariantId: invariant.id,
                severity: invariant.severity,
                rule: invariant.rule,
                file,
                message: `File '${file}' missing required field '${field}'`,
              });
            }
          }
        } catch {
          // skip unreadable files
        }
      }
      break;
    }
    case "path-exclusion": {
      for (const file of matchedFiles) {
        violations.push({
          invariantId: invariant.id,
          severity: invariant.severity,
          rule: invariant.rule,
          file,
          message: `File '${file}' matches excluded pattern`,
        });
      }
      break;
    }
  }

  return violations;
}

export function checkInvariants(
  profile: StackProfile,
  workspaceRoot: string,
): InvariantCheckResult[] {
  if (!profile.invariants || profile.invariants.length === 0) {
    return [];
  }

  const allFiles: string[] = [];
  collectFiles(workspaceRoot, workspaceRoot, allFiles);

  return profile.invariants.map((invariant) => {
    if (!invariant.check) {
      return {
        invariantId: invariant.id,
        severity: invariant.severity,
        rule: invariant.rule,
        checked: false,
        violations: [],
      };
    }

    const violations = runCheck(invariant, allFiles, workspaceRoot, invariant.check);

    return {
      invariantId: invariant.id,
      severity: invariant.severity,
      rule: invariant.rule,
      checked: true,
      violations,
    };
  });
}
