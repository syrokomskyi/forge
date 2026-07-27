/*
<MODULE_CONTRACT>
<purpose>naming.convention.lint — validates that every filename in registered repo roots
uses kebab-case (lowercase letters, digits, hyphens only), with documented exemptions.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0303: split out of structure.ts (Phase 3 file-size split).</item>
  <item>RFC-0360: extend scan roots from apps/ and packages/ to the whole repo.</item>
</CHANGE_SUMMARY>
*/

import { basename, join, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { readdirSync, type Dirent } from "node:fs";
import { collectFiles } from "../../src/utils/fs.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

// @ai-invariant The exception rules below are the canonical source for naming.convention.lint.
// Update naming-conventions.md (packages/site-kernel/docs/) when these rules change.

// RFC-0360: Registered recursive roots — scanned recursively for filename violations.
const NAMING_CONVENTION_RECURSIVE_ROOTS = [
  "apps",
  "packages",
  "services",
  "docs",
  "integrations",
  "onboarding",
  "fleet",
  "hooks",
  "tools",
  "scripts",
  "systems",
  "tsconfig",
] as const;

// RFC-0360: Registered ephemeral roots — root name validated, contents skipped unless --include-ignored.
const NAMING_CONVENTION_EPHEMERAL_ROOTS = ["missions", "releases", "agents", ".werkstatt"] as const;

// RFC-0360: Tool/cache directories that are never scanned at any level.
const NAMING_CONVENTION_IGNORED_TOP_LEVEL = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".astro",
  ".wrangler",
  ".vscode",
  ".idea",
  "coverage",
  ".changelog-system",
  ".codex-runlogs",
  ".agents",
  ".claude",
  ".github",
  ".opencode",
  ".windsurf",
  ".cache",
  "tmp",
]);

// Tool-mandated filenames exempt from kebab-case (Docker, Caddy use these exact names).
const NAMING_CONVENTION_TOOL_MANDATED = new Set(["Dockerfile", "Caddyfile"]);
const NAMING_CONVENTION_IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  ".astro",
  ".wrangler",
  ".vscode",
  ".idea",
  "coverage",
  "spec",
  "todo",
  // Generated, gitignored media-artifact dirs under public/ — their filenames are owned by the
  // generators, not authored: RFC-0204 responsive image variants (_img) and RFC-0210 video
  // variants / HLS segments (_video, e.g. "1080p_000.ts", where ".ts" is MPEG-TS, not TypeScript).
  "_img",
  "_video",
  // DB migration dirs follow the ordered tool convention "NNN_name.sql" (Supabase/Postgres,
  // RFC-0186) — the numeric-underscore prefix is required for ordering and is not authored prose.
  "migrations",
]);
const NAMING_CONVENTION_EXEMPT_KEYWORDS = ["config", "module"] as const;

// Set of directory paths that are exempt from naming convention (generated files)
const NAMING_CONVENTION_EXEMPT_DIRS = new Set([
  "components/icons/gen", // Generated icon components — naming controlled by generator
]);

/**
 * Returns true when a filename is exempt from kebab-case enforcement.
 *
 * Exemptions (see naming-conventions.md for the canonical description):
 *   1. File name starts with a dot (.env, .gitignore, ...).
 *   2. File name starts with an underscore (_shared.ts, _headers, etc.).
 *   3. File name is ALLCAPS (AGENTS.md, README.md, LICENSE, etc.).
 *   4. File name (full, including extension) contains "config" or "module".
 *   5. File is in an exempt directory (components/icons/gen — generated files).
 *   6. Base icon component (LordIconBase.astro) — used by generated icon components.
 */
function isNamingExempt(fileName: string, filePath?: string): boolean {
  if (fileName.startsWith(".")) return true;
  if (fileName.startsWith("_")) return true;
  if (NAMING_CONVENTION_TOOL_MANDATED.has(fileName)) return true;
  // SHOUTY_SNAKE_CASE files are exempt (AGENTS.md, README.md, LICENSE,
  // ICONS_GENERATE.md, etc.). RFC-0132 extension: the check uses the FIRST
  // stem segment so multi-segment names like AGENTS.template.md and
  // SCHEMA.draft.md inherit the exemption from their canonical first segment
  // — this is intentional for template files whose generated artifact carries
  // the canonical name (AGENTS.template.md → AGENTS.md after agents.generate).
  const firstDotIndex = fileName.indexOf(".");
  const firstStem = firstDotIndex > 0 ? fileName.slice(0, firstDotIndex) : fileName;
  if (firstStem.length > 0 && /^[A-Z]+(_[A-Z]+)*$/.test(firstStem)) return true;
  for (const keyword of NAMING_CONVENTION_EXEMPT_KEYWORDS) {
    if (fileName.includes(keyword)) return true;
  }
  // Check if file is in an exempt directory
  if (filePath) {
    for (const exemptDir of NAMING_CONVENTION_EXEMPT_DIRS) {
      if (filePath.includes(exemptDir)) return true;
    }
  }
  return false;
}

/**
 * Returns true when a filename violates the kebab-case convention.
 * Violations: underscores OR mixed-case (PascalCase, camelCase).
 * Note: ALLCAPS files are exempt, not violations.
 * Only called when the file is not already exempt.
 */
function hasNamingViolation(fileName: string): boolean {
  const dotIndex = fileName.lastIndexOf(".");
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  // kebab-case allows only lowercase letters, digits, and hyphens
  // Violations: underscores OR mixed-case (contains both upper and lower)
  if (stem.includes("_")) return true;
  // Mixed case: has at least one uppercase AND at least one lowercase
  const hasUpper = /[A-Z]/.test(stem);
  const hasLower = /[a-z]/.test(stem);
  return hasUpper && hasLower;
}

/**
 * Reads a gitignore-style file and returns a set of simple (no-wildcard) patterns.
 * Patterns containing `*` or `?` are skipped — too complex without a full gitignore engine.
 */
async function readSimpleIgnorePatterns(filePath: string): Promise<Set<string>> {
  const patterns = new Set<string>();
  try {
    const content = await readFile(filePath, "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.includes("*") || line.includes("?")) continue;
      patterns.add(line.replace(/^\//, "").replace(/\/$/, ""));
    }
  } catch {
    // File absent — silently skip
  }
  return patterns;
}

function isSegmentIgnored(relPath: string, ignorePatterns: Set<string>): boolean {
  for (const segment of relPath.split("/")) {
    if (ignorePatterns.has(segment)) return true;
  }
  return false;
}

async function collectAllFilesForNaming(
  dirPath: string,
  ignorePatterns: Set<string>,
): Promise<string[]> {
  return collectFiles(dirPath, {
    ignore: (name) =>
      name.startsWith(".") ||
      NAMING_CONVENTION_IGNORED_DIRS.has(name) ||
      ignorePatterns.has(name) ||
      ignorePatterns.has(`${name}/`),
  });
}

interface NamingScanPlan {
  recursiveRoots: string[];
  ephemeralRoots: string[];
  unknown: string[];
}

function isRegisteredOrIgnoredTopLevel(name: string): boolean {
  return (
    (NAMING_CONVENTION_RECURSIVE_ROOTS as readonly string[]).includes(name) ||
    (NAMING_CONVENTION_EPHEMERAL_ROOTS as readonly string[]).includes(name) ||
    NAMING_CONVENTION_IGNORED_TOP_LEVEL.has(name)
  );
}

function resolveScanPlan(repoRoot: string): NamingScanPlan {
  let entries: Dirent[];
  try {
    entries = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return {
      recursiveRoots: [...NAMING_CONVENTION_RECURSIVE_ROOTS],
      ephemeralRoots: [...NAMING_CONVENTION_EPHEMERAL_ROOTS],
      unknown: [],
    };
  }

  const topLevelDirs = entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => e.name);

  const unknown = topLevelDirs.filter((name) => !isRegisteredOrIgnoredTopLevel(name));
  const recursiveRoots = (NAMING_CONVENTION_RECURSIVE_ROOTS as readonly string[]).filter((name) =>
    topLevelDirs.includes(name),
  );
  const ephemeralRoots = (NAMING_CONVENTION_EPHEMERAL_ROOTS as readonly string[]).filter((name) =>
    topLevelDirs.includes(name),
  );

  return { recursiveRoots, ephemeralRoots, unknown };
}

/**
 * Validates that all filenames in registered repo roots use kebab-case.
 *
 * Rule: filenames must use only lowercase letters, digits, and hyphens.
 * Violations: underscores, uppercase letters (PascalCase, camelCase, ALLCAPS).
 *
 * Exceptions (not flagged):
 *   - Files starting with a dot (.env, .gitignore)
 *   - Files starting with an underscore (_shared.ts, _headers, _redirects, _routes.json)
 *   - Tool-mandated filenames (Dockerfile, Caddyfile)
 *   - Files containing "config" or "module" in their name (astro.config.mjs, check.module.ts)
 *   - Files in directories starting with a dot (.git, .astro, .vscode)
 *   - Files excluded by .gitignore or .windsurfignore (simple non-wildcard patterns only)
 *
 * See packages/site-kernel/docs/naming-conventions.md — "Global Rule" section.
 */
export async function runNamingConventionLint(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    violations: number;
    checkedFiles: number;
    scannedRoots?: string[];
    ephemeralRootsSkipped?: string[];
    unknownTopLevelDirs?: string[];
  }>
> {
  const workspaceRoot = context.workspaceRoot;
  const includeIgnored = input.flags["include-ignored"] === true;

  const gitignorePatterns = await readSimpleIgnorePatterns(join(workspaceRoot, ".gitignore"));
  const windsurfignorePatterns = await readSimpleIgnorePatterns(
    join(workspaceRoot, ".windsurfignore"),
  );
  const ignorePatterns = new Set([...gitignorePatterns, ...windsurfignorePatterns]);

  let violations = 0;
  let checkedFiles = 0;

  // App-scoped mode: scan only the app directory
  if (context.site) {
    const files = await collectAllFilesForNaming(context.site.directory, ignorePatterns);
    for (const filePath of files) {
      const fileName = basename(filePath);
      const relPath = relative(workspaceRoot, filePath).replace(/\\/g, "/");
      if (isNamingExempt(fileName, relPath)) continue;
      if (isSegmentIgnored(relPath, ignorePatterns)) continue;
      checkedFiles += 1;
      if (hasNamingViolation(fileName)) {
        context.logger.error(
          `${relPath}: "${fileName}" violates kebab-case — use only lowercase letters, digits, and hyphens`,
        );
        violations += 1;
      }
    }
    return {
      data: { violations, checkedFiles },
      exitCode: violations > 0 ? 1 : 0,
      summary:
        violations > 0
          ? undefined
          : `[naming.convention] OK (${checkedFiles} non-exempt files checked)`,
    };
  }

  // Workspace-scoped mode: resolve scan plan from filesystem
  const scanPlan = resolveScanPlan(workspaceRoot);

  // Report unknown top-level directories
  for (const unknownDir of scanPlan.unknown) {
    context.logger.error(
      `[naming.convention.lint] unknown top-level directory '${unknownDir}'; register it or remove it`,
    );
    violations += 1;
  }

  // Validate ephemeral root names (kebab-case check on the root name itself)
  for (const ephemeral of scanPlan.ephemeralRoots) {
    const name = ephemeral.startsWith(".") ? ephemeral.slice(1) : ephemeral;
    if (name && !name.includes("_") && !(/[A-Z]/.test(name) && /[a-z]/.test(name))) {
      // ok
    } else if (name && (name.includes("_") || (/[A-Z]/.test(name) && /[a-z]/.test(name)))) {
      context.logger.error(
        `[naming.convention.lint] top-level directory '${ephemeral}' violates naming convention`,
      );
      violations += 1;
    }
  }

  // Scan recursive roots
  for (const rootName of scanPlan.recursiveRoots) {
    const scanDir = join(workspaceRoot, rootName);
    const files = await collectAllFilesForNaming(scanDir, ignorePatterns);

    for (const filePath of files) {
      const fileName = basename(filePath);
      const relPath = relative(workspaceRoot, filePath).replace(/\\/g, "/");
      if (isNamingExempt(fileName, relPath)) continue;
      if (isSegmentIgnored(relPath, ignorePatterns)) continue;
      checkedFiles += 1;
      if (hasNamingViolation(fileName)) {
        context.logger.error(
          `${relPath}: "${fileName}" violates kebab-case — use only lowercase letters, digits, and hyphens`,
        );
        violations += 1;
      }
    }
  }

  // Scan ephemeral root contents only when --include-ignored is passed
  if (includeIgnored) {
    for (const rootName of scanPlan.ephemeralRoots) {
      const scanDir = join(workspaceRoot, rootName);
      const files = await collectAllFilesForNaming(scanDir, ignorePatterns);
      for (const filePath of files) {
        const fileName = basename(filePath);
        const relPath = relative(workspaceRoot, filePath).replace(/\\/g, "/");
        if (isNamingExempt(fileName, relPath)) continue;
        if (isSegmentIgnored(relPath, ignorePatterns)) continue;
        checkedFiles += 1;
        if (hasNamingViolation(fileName)) {
          context.logger.error(
            `${relPath}: "${fileName}" violates kebab-case — use only lowercase letters, digits, and hyphens`,
          );
          violations += 1;
        }
      }
    }
  }

  return {
    data: {
      violations,
      checkedFiles,
      scannedRoots: scanPlan.recursiveRoots,
      ephemeralRootsSkipped: includeIgnored ? [] : scanPlan.ephemeralRoots,
      unknownTopLevelDirs: scanPlan.unknown,
    },
    exitCode: violations > 0 ? 1 : 0,
    summary:
      violations > 0
        ? undefined
        : `[naming.convention] OK (${checkedFiles} non-exempt files checked)`,
  };
}
