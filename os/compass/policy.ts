/*
<MODULE_CONTRACT>
<purpose>Compass policy resolution — generic defaults overlaid by the stack
profile's compass section (forge.yaml `profile` field, RFC-0643) and the
consumer's bindings.compass overrides. Single source of truth for which files
are authored, how risky they are, and what counts as a governance ID
(RFC-1096).</purpose>
<non-goals>
  <item>Do not scan files or classify entries — that lives in handlers/compass-inventory.ts.</item>
  <item>Do not register commands — this is a pure policy module.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1096: initial policy resolver — generic defaults + profile compass section + bindings.compass overrides.</item>
</CHANGE_SUMMARY>
*/

import picomatch from "picomatch";
import { loadForgeConfig } from "../../src/config/forge-config.ts";
import type { CompassPolicyOverrides } from "../../src/profiles/profile-schema.ts";

export type CompassRiskClass = "high" | "medium" | "low";
export type CompassWorkspaceKind = "app" | "package" | "service";

export interface CompassLayerRule {
  pattern: string;
  layer: string;
  risk: CompassRiskClass;
}

export interface CompassExcludedPath {
  pattern: string;
  reason: string;
}

export interface CompassPolicySource {
  /** Stack profile id that contributed a `compass:` section, or null. */
  profile: string | null;
  /** Keys the consumer's bindings.compass overrode. */
  overriddenKeys: string[];
}

export interface CompassPolicy {
  fileExtensions: ReadonlySet<string>;
  testPatterns: readonly string[];
  scanRoots: readonly string[];
  ignoredDirs: ReadonlySet<string>;
  ignoredDirPrefixes: readonly string[];
  /** picomatch globs on the root-relative path that force riskClass=high. */
  highRiskPaths: readonly string[];
  /** Governance-ID detection pattern (unanchored, as configured). */
  idPattern: RegExp;
  /** `^(?:idPattern)$` — full-string governance-ID match. */
  idPatternFull: RegExp;
  /** `^(?:idPattern)` — leading governance-ID match. */
  idPatternPrefix: RegExp;
  purposeBoilerplatePatterns: readonly RegExp[];
  /** Ordered first-match layer rules on the workspace-relative path. */
  layerRules: readonly CompassLayerRule[];
  workspaceKinds: Readonly<Record<string, CompassWorkspaceKind>>;
  /** Workspace-relative globs that mark a file excluded with a reason. */
  excludedPaths: readonly CompassExcludedPath[];
  source: CompassPolicySource;
  /** First-match layer rule for a workspace-relative path. */
  matchLayer(workspaceRelativePath: string): CompassLayerRule | undefined;
  /** Whether a root-relative path is forced high-risk. */
  isHighRisk(pathFromRoot: string): boolean;
  /** Whether a workspace-relative path is a test file. */
  isTestPath(workspaceRelativePath: string): boolean;
  /** Exclusion reason for a workspace-relative path, if any. */
  excludedReason(workspaceRelativePath: string): string | undefined;
}

export class CompassPolicyConfigError extends Error {
  readonly key: string;
  constructor(key: string, detail: string) {
    super(`[compass.policy] invalid compass policy key "${key}": ${detail}`);
    this.name = "CompassPolicyConfigError";
    this.key = key;
  }
}

// ---------------------------------------------------------------------------
// Generic defaults — stack-neutral values only. Consumer- or stack-specific
// literals are forbidden here (RFC-1096 AC-4); they live in profiles or
// forge.yaml bindings.compass.
// ---------------------------------------------------------------------------

const GENERIC_FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".astro",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".css",
  ".cs",
  ".tscn",
  ".tres",
  ".gd",
  ".md",
];

const GENERIC_IGNORED_DIRS = [
  ".git",
  ".turbo",
  ".astro",
  ".wrangler",
  ".vscode",
  ".cache",
  "coverage",
  "dist",
  "node_modules",
];

const GENERIC_SCAN_ROOTS = ["src", "apps", "packages", "services"];

const GENERIC_TEST_PATTERNS = [
  "test/**",
  "**/*.test.ts",
  "**/*.test.js",
  "**/*.spec.ts",
  "**/*.spec.js",
];

const GENERIC_ID_PATTERN = "\\b([A-Z][A-Z0-9]*-)+\\d+\\b";

const GENERIC_PURPOSE_BOILERPLATE = [
  "^(this file|the file|a file|this module|a module)\\b",
  "^(utility|utilities|helper|helpers|misc)\\b",
  "^(todo|placeholder|fixme)\\b",
];

const GENERIC_LAYER_RULES: CompassLayerRule[] = [
  { pattern: "bin/**", layer: "bin", risk: "low" },
  { pattern: "src/middleware.ts", layer: "middleware", risk: "low" },
  { pattern: "src/middleware/**", layer: "middleware", risk: "high" },
  { pattern: "src/pages/**", layer: "page", risk: "medium" },
  { pattern: "src/components/**", layer: "component", risk: "medium" },
  { pattern: "src/content/schemas/**", layer: "schema", risk: "medium" },
  { pattern: "src/content/**", layer: "content", risk: "low" },
  { pattern: "src/styles/**", layer: "style", risk: "low" },
  { pattern: "src/scripts/**", layer: "script", risk: "medium" },
  { pattern: "src/layouts/**", layer: "layout", risk: "high" },
  { pattern: "src/utils/**", layer: "utility", risk: "medium" },
  { pattern: "src/configure/**", layer: "config", risk: "low" },
  { pattern: "test/**", layer: "test", risk: "low" },
  { pattern: "src/tests/**", layer: "test", risk: "low" },
  { pattern: "**/*.test.ts", layer: "test", risk: "low" },
  { pattern: "**/*.spec.ts", layer: "test", risk: "low" },
  { pattern: "src/**", layer: "source", risk: "low" },
  { pattern: "**/SKILL.md", layer: "skill", risk: "low" },
];

const GENERIC_WORKSPACE_KINDS: Record<string, CompassWorkspaceKind> = {
  apps: "app",
  packages: "package",
  services: "service",
};

// ---------------------------------------------------------------------------
// Merge semantics (RFC-1096): union keys merge with `!entry` subtraction
// (fileExtensions, testPatterns, ignoredDirs, ignoredDirPrefixes, highRiskPaths,
// excludedPaths — matched by `pattern`); scanRoots, idPattern,
// purposeBoilerplatePatterns, layerRules, and workspaceKinds replace wholesale
// (bindings > profile > generic).
// ---------------------------------------------------------------------------

function mergeStringList(
  generic: readonly string[],
  ...overrides: Array<readonly string[] | undefined>
): string[] {
  const result = new Set(generic);
  for (const list of overrides) {
    for (const item of list ?? []) {
      if (item.startsWith("!")) {
        result.delete(item.slice(1));
      } else {
        result.add(item);
      }
    }
  }
  return [...result];
}

function mergeExcludedPaths(
  generic: readonly CompassExcludedPath[],
  ...overrides: Array<readonly CompassExcludedPath[] | undefined>
): CompassExcludedPath[] {
  const byPattern = new Map<string, string>();
  for (const entry of generic) {
    byPattern.set(entry.pattern, entry.reason);
  }
  for (const list of overrides) {
    for (const entry of list ?? []) {
      if (entry.pattern.startsWith("!")) {
        byPattern.delete(entry.pattern.slice(1));
      } else {
        byPattern.set(entry.pattern, entry.reason);
      }
    }
  }
  return [...byPattern.entries()].map(([pattern, reason]) => ({ pattern, reason }));
}

function compilePattern(key: string, pattern: string, flags?: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    throw new CompassPolicyConfigError(key, `not a compilable regex: ${pattern}`);
  }
}

/** Split a `NAMESPACE-NUMBER` governance ID on its last dash. */
export function parseGovernanceIdParts(id: string): { namespace: string; numeric: number } | null {
  const match = id.match(/^(.*)-(\d+)$/);
  if (!match) return null;
  return { namespace: match[1]!, numeric: Number(match[2]) };
}

/**
 * Resolve the effective Compass policy for a workspace: generic defaults,
 * overlaid by the stack profile `compass:` section (when forge.yaml declares
 * `profile`), then by `bindings.compass`. Missing or unreadable forge.yaml
 * yields the generic policy. Invalid regexes throw CompassPolicyConfigError
 * naming the offending key.
 */
export function resolveCompassPolicy(workspaceRoot: string, forgeRoot?: string): CompassPolicy {
  let profileCompass: CompassPolicyOverrides | undefined;
  let bindingsCompass: CompassPolicyOverrides | undefined;
  let profileId: string | null = null;
  try {
    const config = loadForgeConfig(workspaceRoot, forgeRoot);
    profileCompass = config.profile?.compass;
    bindingsCompass = config.bindings?.compass;
    profileId = config.profile?.id ?? null;
  } catch {
    // No forge.yaml or unreadable config — generic policy only.
  }

  const overriddenKeys = Object.keys(bindingsCompass ?? {}).filter(
    (key) => (bindingsCompass as Record<string, unknown>)[key] !== undefined,
  );

  const fileExtensions = mergeStringList(
    GENERIC_FILE_EXTENSIONS,
    profileCompass?.fileExtensions,
    bindingsCompass?.fileExtensions,
  );
  const testPatterns = mergeStringList(
    GENERIC_TEST_PATTERNS,
    profileCompass?.testPatterns,
    bindingsCompass?.testPatterns,
  );
  const ignoredDirs = mergeStringList(
    GENERIC_IGNORED_DIRS,
    profileCompass?.ignoredDirs,
    bindingsCompass?.ignoredDirs,
  );
  const ignoredDirPrefixes = mergeStringList(
    [],
    profileCompass?.ignoredDirPrefixes,
    bindingsCompass?.ignoredDirPrefixes,
  );
  const highRiskPaths = mergeStringList(
    [],
    profileCompass?.highRiskPaths,
    bindingsCompass?.highRiskPaths,
  );
  const excludedPaths = mergeExcludedPaths(
    [],
    profileCompass?.excludedPaths,
    bindingsCompass?.excludedPaths,
  );
  const layerRules =
    bindingsCompass?.layerRules ?? profileCompass?.layerRules ?? GENERIC_LAYER_RULES;
  const workspaceKinds: Record<string, CompassWorkspaceKind> =
    bindingsCompass?.workspaceKinds ?? profileCompass?.workspaceKinds ?? GENERIC_WORKSPACE_KINDS;
  const scanRoots = bindingsCompass?.scanRoots ?? profileCompass?.scanRoots ?? GENERIC_SCAN_ROOTS;

  const idPatternRaw =
    bindingsCompass?.idPattern ?? profileCompass?.idPattern ?? GENERIC_ID_PATTERN;
  const idPattern = compilePattern("idPattern", idPatternRaw);
  if (!idPattern.test("ABC-123")) {
    throw new CompassPolicyConfigError(
      "idPattern",
      `must match NAMESPACE-NUMBER governance ids (probe "ABC-123" failed): ${idPatternRaw}`,
    );
  }
  const idPatternFull = new RegExp(`^(?:${idPattern.source})$`);
  const idPatternPrefix = new RegExp(`^(?:${idPattern.source})`);

  const boilerplateRaw =
    bindingsCompass?.purposeBoilerplatePatterns ??
    profileCompass?.purposeBoilerplatePatterns ??
    GENERIC_PURPOSE_BOILERPLATE;
  // Boilerplate detectors match English prose — always case-insensitive.
  const purposeBoilerplatePatterns = boilerplateRaw.map((pattern) =>
    compilePattern("purposeBoilerplatePatterns", pattern, "i"),
  );

  const layerMatchers = layerRules.map((rule) => ({
    rule,
    is: picomatch(rule.pattern, { dot: true }),
  }));
  const highRiskMatchers = highRiskPaths.map((pattern) => picomatch(pattern, { dot: true }));
  const testMatchers = testPatterns.map((pattern) => picomatch(pattern, { dot: true }));
  const excludedMatchers = excludedPaths.map((entry) => ({
    reason: entry.reason,
    is: picomatch(entry.pattern, { dot: true }),
  }));

  return Object.freeze({
    fileExtensions: new Set(fileExtensions),
    testPatterns,
    scanRoots,
    ignoredDirs: new Set(ignoredDirs),
    ignoredDirPrefixes,
    highRiskPaths,
    idPattern,
    idPatternFull,
    idPatternPrefix,
    purposeBoilerplatePatterns,
    layerRules,
    workspaceKinds,
    excludedPaths,
    source: { profile: profileId, overriddenKeys },
    matchLayer(workspaceRelativePath: string): CompassLayerRule | undefined {
      for (const { rule, is } of layerMatchers) {
        if (is(workspaceRelativePath)) return rule;
      }
      return undefined;
    },
    isHighRisk(pathFromRoot: string): boolean {
      return highRiskMatchers.some((is) => is(pathFromRoot));
    },
    isTestPath(workspaceRelativePath: string): boolean {
      return testMatchers.some((is) => is(workspaceRelativePath));
    },
    excludedReason(workspaceRelativePath: string): string | undefined {
      for (const { reason, is } of excludedMatchers) {
        if (is(workspaceRelativePath)) return reason;
      }
      return undefined;
    },
  });
}
