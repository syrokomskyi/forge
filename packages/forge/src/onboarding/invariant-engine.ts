/*
<MODULE_CONTRACT>
<purpose>Generic invariant enforcement engine — reads check declarations from profile invariants and verifies files against them. Supports filename-pattern, file-contains, and file-not-contains check kinds.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
  <item>Do not implement domain-specific validation logic — all rules are declared in profile YAML.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0675: initial invariant enforcement engine with three check kinds.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
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

function collectFiles(dir: string, baseDir: string, results: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, results);
    } else {
      results.push(relPath);
    }
  }
}

function checkFilenamePattern(
  invariant: ProfileInvariant,
  workspaceRoot: string,
  check: NonNullable<ProfileInvariant["check"]>,
): InvariantViolation[] {
  if (!check.glob || !check.pattern) {
    return [];
  }

  const allFiles: string[] = [];
  collectFiles(workspaceRoot, workspaceRoot, allFiles);

  const matchedFiles = allFiles.filter((f) => matchGlob(f, check.glob!));
  const violations: InvariantViolation[] = [];

  let regex: RegExp;
  try {
    regex = new RegExp(check.pattern);
  } catch (err) {
    const e = err as Error;
    return [
      {
        invariantId: invariant.id,
        severity: "warning",
        rule: invariant.rule,
        file: "",
        message: `Invariant ${invariant.id} has invalid check pattern: ${e.message}`,
      },
    ];
  }

  for (const file of matchedFiles) {
    const filename = path.basename(file);
    if (!regex.test(filename)) {
      violations.push({
        invariantId: invariant.id,
        severity: invariant.severity,
        rule: invariant.rule,
        file,
        message: `Filename '${filename}' does not match pattern '${check.pattern}'`,
      });
    }
  }

  return violations;
}

function checkFileContains(
  invariant: ProfileInvariant,
  workspaceRoot: string,
  check: NonNullable<ProfileInvariant["check"]>,
): InvariantViolation[] {
  if (!check.glob || !check.pattern) {
    return [];
  }

  const allFiles: string[] = [];
  collectFiles(workspaceRoot, workspaceRoot, allFiles);

  const matchedFiles = allFiles.filter((f) => matchGlob(f, check.glob!));
  const violations: InvariantViolation[] = [];

  let regex: RegExp;
  try {
    regex = new RegExp(check.pattern);
  } catch (err) {
    const e = err as Error;
    return [
      {
        invariantId: invariant.id,
        severity: "warning",
        rule: invariant.rule,
        file: "",
        message: `Invariant ${invariant.id} has invalid check pattern: ${e.message}`,
      },
    ];
  }

  for (const file of matchedFiles) {
    const fullPath = path.join(workspaceRoot, file);
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      if (!regex.test(content)) {
        violations.push({
          invariantId: invariant.id,
          severity: invariant.severity,
          rule: invariant.rule,
          file,
          message: `File '${file}' does not contain pattern '${check.pattern}'`,
        });
      }
    } catch {
      // skip unreadable files
    }
  }

  return violations;
}

function checkFileNotContains(
  invariant: ProfileInvariant,
  workspaceRoot: string,
  check: NonNullable<ProfileInvariant["check"]>,
): InvariantViolation[] {
  if (!check.glob || !check.negatedPattern) {
    return [];
  }

  const allFiles: string[] = [];
  collectFiles(workspaceRoot, workspaceRoot, allFiles);

  const matchedFiles = allFiles.filter((f) => matchGlob(f, check.glob!));
  const violations: InvariantViolation[] = [];

  let regex: RegExp;
  try {
    regex = new RegExp(check.negatedPattern);
  } catch (err) {
    const e = err as Error;
    return [
      {
        invariantId: invariant.id,
        severity: "warning",
        rule: invariant.rule,
        file: "",
        message: `Invariant ${invariant.id} has invalid check pattern: ${e.message}`,
      },
    ];
  }

  for (const file of matchedFiles) {
    const fullPath = path.join(workspaceRoot, file);
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      if (regex.test(content)) {
        violations.push({
          invariantId: invariant.id,
          severity: invariant.severity,
          rule: invariant.rule,
          file,
          message: `File '${file}' contains forbidden pattern '${check.negatedPattern}'`,
        });
      }
    } catch {
      // skip unreadable files
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

    let violations: InvariantViolation[] = [];
    switch (invariant.check.kind) {
      case "filename-pattern":
        violations = checkFilenamePattern(invariant, workspaceRoot, invariant.check);
        break;
      case "file-contains":
        violations = checkFileContains(invariant, workspaceRoot, invariant.check);
        break;
      case "file-not-contains":
        violations = checkFileNotContains(invariant, workspaceRoot, invariant.check);
        break;
    }

    return {
      invariantId: invariant.id,
      severity: invariant.severity,
      rule: invariant.rule,
      checked: true,
      violations,
    };
  });
}
