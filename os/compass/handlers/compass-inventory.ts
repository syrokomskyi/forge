/*
<MODULE_CONTRACT>
<purpose>Canonical Compass inventory scanning logic. Moved from @warpgogol/site-kernel
to @warpgogol/forge for full autonomous mode (RFC-0556). Provides file collection,
workspace detection, layer classification, risk assessment, and compliance checking
for Compass source-file inventory.</purpose>
<non-goals>
  <item>Do not render XML output — that belongs in the compass command handler.</item>
  <item>Do not register commands — this is a pure utility module.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0556: moved canonical implementation from @warpgogol/site-kernel to @warpgogol/forge for autonomous mode.</item>
  <item>Game extensions: added .cs, .tscn, .tres, .gd to SOURCE_EXTENSIONS; createCompassInventoryEntries now reads forge.yaml compass.fileExtensions at runtime and merges with hardcoded set.</item>
  <item>Added .md to SOURCE_EXTENSIONS for SKILL.md Compass coverage; detectAuthoringStatus excludes non-SKILL.md markdown files.</item>
  <item>RFC-1094: v2 contract — KEY_DECISIONS/history parsing, new inventory fields, evaluateV2Rules, deriveFileTokens, resolveCompassMode, shared GOVERNANCE_ID_RE.</item>
  <item>RFC-1095: compass.summary.record, trim repair rewrite, commit integration</item>
  <history>RFC-0348</history>
</CHANGE_SUMMARY>
*/

import { readdir, readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ForgeCommandInput } from "../../../src/types.ts";
import { hasGeneratedMarker } from "../../../src/utils/generated-marker.ts";

function loadCompassExtensionsFromForgeYaml(workspaceRoot: string): Set<string> {
  const forgeYamlPath = join(workspaceRoot, "forge.yaml");
  if (!existsSync(forgeYamlPath)) {
    return new Set();
  }
  try {
    const raw = readFileSync(forgeYamlPath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    const bindings = parsed?.bindings as Record<string, unknown> | undefined;
    const compass = bindings?.compass as Record<string, unknown> | undefined;
    const extensions = compass?.fileExtensions;
    if (Array.isArray(extensions)) {
      return new Set(extensions.filter((e: unknown) => typeof e === "string"));
    }
  } catch {
    // forge.yaml not parseable or missing compass section — fall back to hardcoded set
  }
  return new Set();
}

const SOURCE_EXTENSIONS = new Set([
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
]);
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".turbo",
  ".astro",
  ".wrangler",
  ".vscode",
  ".cache",
  "coverage",
  "dist",
  "node_modules",
  "spec",
  "todo",
]);
const DEFAULT_SCAN_ROOTS = ["apps", "packages", "services"];
const HIGH_RISK_EXACT_RELATIVE_PATHS = new Set([
  "apps/main/src/content/config.ts",
  "apps/main/src/middleware.ts",
  "packages/os/site-kernel/src/cli/index.ts",
  "packages/os/site-kernel/src/discovery.ts",
  "packages/os/site-kernel/src/registry.ts",
  "packages/os/site-kernel/src/runtime.ts",
  "packages/os/site-kernel/src/types.ts",
]);
function forbiddenMarkerPattern(tagName: string): RegExp {
  return new RegExp(`<${tagName}\\b`);
}

const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "MODULE_MAP", regex: forbiddenMarkerPattern("MODULE_MAP") },
  { name: "keywords", regex: forbiddenMarkerPattern("keywords") },
  { name: "responsibilities", regex: forbiddenMarkerPattern("responsibilities") },
  { name: "COMPASS_BLOCK", regex: new RegExp(`</?${"COMPASS_BLOCK"}\\b`) },
];

// RFC-1094: v2 contract constants. GOVERNANCE_ID_RE is the canonical
// governance-ID pattern shared with the change-summary handler.
export const GOVERNANCE_ID_RE = /\b([A-Z][A-Z0-9]*-)+\d+\b/;
const GOVERNANCE_ID_PREFIX_RE = /^([A-Z][A-Z0-9]*-)+\d+\b/;
const HISTORY_ID_RE = /^([A-Z][A-Z0-9]*-)+\d+$/;
const HISTORY_ID_PARTS_RE = /^(([A-Z][A-Z0-9]*-)+)(\d+)$/;
const TODO_PLACEHOLDER_RE = /^TODO\b/i;

const GENERIC_STEMS = new Set([
  "index",
  "styles",
  "style",
  "local",
  "global",
  "utils",
  "helpers",
  "types",
  "constants",
  "readme",
]);
const SYMBOL_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);
const EXPORTED_SYMBOL_RE =
  /export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+(\w+)/g;

const PURPOSE_BOILERPLATE_PATTERNS: RegExp[] = [
  /^(this file|the file|a file|this module|a module)\b/i,
  /^(utility|utilities|helper|helpers|misc)\b/i,
  /^(todo|placeholder|fixme)\b/i,
];

const KEY_DECISIONS_MAX_ITEMS = 7;
const KEY_DECISIONS_MAX_WORDS = 20;
const CHANGE_SUMMARY_MAX_ITEMS = 5;

export type CompassValidationMode = "warning" | "error";

export interface CompassV2Diagnostic {
  ruleId: string;
  message: string;
  fix: string;
}

export function resolveCompassMode(input: ForgeCommandInput): CompassValidationMode {
  const raw = input.flags["mode"];
  if (raw === undefined) return "warning";
  if (raw === "warning" || raw === "error") return raw;
  throw new Error(`--mode must be "warning" or "error", got "${String(raw)}"`);
}

type CompassWorkspaceKind = "app" | "package" | "service";
type CompassRiskClass = "high" | "medium" | "low";
type CompassComplexity = "non-trivial" | "trivial";
type CompassScaffoldingMode = "standard" | "none";
type CompassAuthoringStatus = "authored" | "excluded";

export interface CompassInventoryEntry {
  path: string;
  workspaceKind: CompassWorkspaceKind;
  workspaceName: string;
  layer: string;
  extension: string;
  authoringStatus: CompassAuthoringStatus;
  exclusionReason?: string;
  riskClass: CompassRiskClass;
  complexity: CompassComplexity;
  requiredScaffolding: CompassScaffoldingMode;
  nonEmptyLineCount: number;
  hasModuleContract: boolean;
  hasChangeSummary: boolean;
  hasKeyDecisions: boolean;
  keyDecisionsItemCount: number;
  keyDecisionsRequired: boolean;
  changeSummaryItemCount: number;
  historyIds: string[];
  hasAiInvariant: boolean;
  hasPurpose: boolean;
  hasNonGoals: boolean;
  forbiddenPresent: string[];
  compliant: boolean;
  violations: string[];
}

function getFlagValues(input: ForgeCommandInput, key: string): string[] {
  const value = input.flags[key];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function resolveScanRoots(workspaceRoot: string, input: ForgeCommandInput): string[] {
  const values = getFlagValues(input, "root");
  const roots = values.length > 0 ? values : DEFAULT_SCAN_ROOTS;
  return roots.map((value) => resolve(workspaceRoot, value));
}

function shouldIgnoreDirectory(name: string): boolean {
  if (IGNORED_DIRECTORY_NAMES.has(name)) {
    return true;
  }
  if (name.startsWith("old-")) {
    return true;
  }
  if (name.startsWith("-")) {
    return true;
  }
  return false;
}

function hasRelevantExtension(filePath: string, extraExtensions?: Set<string>): boolean {
  for (const extension of SOURCE_EXTENSIONS) {
    if (filePath.endsWith(extension)) {
      return true;
    }
  }
  if (extraExtensions) {
    for (const extension of extraExtensions) {
      if (filePath.endsWith(extension)) {
        return true;
      }
    }
  }
  return false;
}

async function collectSourceFiles(
  targetPath: string,
  extraExtensions?: Set<string>,
): Promise<string[]> {
  let stat;
  try {
    const { stat: fsStat } = await import("node:fs/promises");
    stat = await fsStat(targetPath);
  } catch {
    return [];
  }

  if (stat.isFile()) {
    return hasRelevantExtension(targetPath, extraExtensions) ? [targetPath] : [];
  }

  let entries;
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(targetPath, entry.name);

    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) {
        continue;
      }

      const normalizedPath = absolutePath.replace(/\\/g, "/");
      if (
        normalizedPath.endsWith("/src/assets") ||
        normalizedPath.endsWith("/src/icons/gen") ||
        normalizedPath.includes("/public/_video") ||
        normalizedPath.includes("/public/_img")
      ) {
        continue;
      }

      files.push(...(await collectSourceFiles(absolutePath, extraExtensions)));
      continue;
    }

    if (entry.isFile() && hasRelevantExtension(absolutePath, extraExtensions)) {
      files.push(absolutePath);
    }
  }

  return files;
}

export function getRelativeSegments(filePath: string, workspaceRoot: string): string[] {
  return relative(workspaceRoot, filePath).replace(/\\/g, "/").split("/").filter(Boolean);
}

function detectWorkspaceKind(segments: string[]): CompassWorkspaceKind {
  if (segments[0] === "services") return "service";
  return segments[0] === "packages" ? "package" : "app";
}

function detectWorkspaceName(segments: string[]): string {
  if (segments[0] === "packages" && segments[1] === "os") {
    return segments[2] ?? "unknown";
  }
  return segments[1] ?? "unknown";
}

export function getWorkspaceRelativeSegments(segments: string[]): string[] {
  if (segments[0] === "packages" && segments[1] === "os") {
    return segments.slice(3);
  }
  return segments.slice(2);
}

export function detectLayer(relativePath: string): string {
  if (relativePath.startsWith("bin/")) return "bin";
  if (relativePath === "tools/kernel.config.ts") return "tool-config";
  if (relativePath.startsWith("tools/modules/")) return "tool-module";
  if (relativePath.startsWith("tools/runtime/")) return "tool-runtime";
  if (relativePath.startsWith("src/middleware/")) return "middleware";
  if (relativePath === "src/middleware.ts") return "middleware";
  if (relativePath.startsWith("src/pages/")) return "page";
  if (relativePath.startsWith("src/components/")) return "component";
  if (relativePath.startsWith("src/content/schemas/")) return "schema";
  if (relativePath.startsWith("src/content/")) return "content";
  if (relativePath.startsWith("src/styles/")) return "style";
  if (relativePath.startsWith("src/scripts/")) return "script";
  if (relativePath.startsWith("src/layouts/")) return "layout";
  if (relativePath.startsWith("src/utils/")) return "utility";
  if (relativePath.startsWith("src/configure/")) return "config";
  if (
    relativePath.startsWith("test/") ||
    relativePath.startsWith("src/tests/") ||
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".spec.ts")
  )
    return "test";
  if (relativePath.startsWith("src/")) return "source";
  if (relativePath.endsWith("SKILL.md")) return "skill";
  return "other";
}

export function detectRiskClass(pathFromRoot: string, layer: string): CompassRiskClass {
  if (HIGH_RISK_EXACT_RELATIVE_PATHS.has(pathFromRoot)) {
    return "high";
  }
  if (pathFromRoot.includes("/src/scripts/layout-scroll/")) {
    return "high";
  }
  if (pathFromRoot.includes("/src/layouts/")) {
    return "high";
  }
  if (pathFromRoot.includes("/src/middleware/")) {
    return "high";
  }
  if (layer === "tool-runtime" || layer === "tool-config" || layer === "schema") {
    return "medium";
  }
  if (layer === "page" || layer === "component" || layer === "utility" || layer === "script") {
    return "medium";
  }
  return "low";
}

function detectComplexity(source: string): CompassComplexity {
  const nonEmptyLineCount = source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  if (nonEmptyLineCount <= 20 && source.length <= 900) {
    return "trivial";
  }
  return "non-trivial";
}

function isSimpleSvgLogoComponent(segments: string[]): boolean {
  return (
    segments.length >= 4 &&
    segments[0] === "apps" &&
    segments[2] === "src" &&
    segments[3] === "components" &&
    segments[4] === "logo"
  );
}

function detectAuthoringStatus(
  segments: string[],
  relativePath: string,
  source: string,
): {
  authoringStatus: CompassAuthoringStatus;
  exclusionReason?: string;
} {
  if (hasGeneratedMarker(source)) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "generated-marker",
    };
  }

  if (relativePath.startsWith("src/icons/gen/")) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "generated-icon-tree",
    };
  }

  if (relativePath.startsWith("src/assets/")) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "assets-directory",
    };
  }

  if (isSimpleSvgLogoComponent(segments)) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "svg-component",
    };
  }

  if (relativePath.startsWith("dist/")) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "generated-dist",
    };
  }

  if (/\.generated\.[a-z]+$/i.test(relativePath)) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "generated-file",
    };
  }

  if (relativePath.startsWith("src/templates/")) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "template-source",
    };
  }

  if (
    relativePath.startsWith("test/") ||
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test.js") ||
    relativePath.endsWith(".spec.ts") ||
    relativePath.endsWith(".spec.js")
  ) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "test-file",
    };
  }

  if (segments.includes("bin")) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "bin-entrypoint",
    };
  }

  if (relativePath.endsWith(".md") && !relativePath.endsWith("SKILL.md")) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "non-skill-markdown",
    };
  }

  const isRootFile = !relativePath.includes("/");
  if (
    isRootFile &&
    (relativePath.endsWith(".config.mjs") ||
      relativePath.endsWith(".config.cjs") ||
      relativePath.endsWith(".config.js") ||
      relativePath.endsWith(".config.ts"))
  ) {
    return {
      authoringStatus: "excluded",
      exclusionReason: "framework-config",
    };
  }

  return { authoringStatus: "authored" };
}

function detectRequiredScaffolding(
  authoringStatus: CompassAuthoringStatus,
): CompassScaffoldingMode {
  if (authoringStatus === "excluded") {
    return "none";
  }

  return "standard";
}

function extractBlockContent(source: string, tagName: string): string | null {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`<${escapedTag}>[\\s\\S]*?<\/${escapedTag}>`));
  return match?.[0] ?? null;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function detectComplianceViolations(
  entry: Pick<
    CompassInventoryEntry,
    | "requiredScaffolding"
    | "riskClass"
    | "hasModuleContract"
    | "hasChangeSummary"
    | "hasAiInvariant"
    | "hasPurpose"
    | "hasNonGoals"
    | "forbiddenPresent"
  >,
): string[] {
  if (entry.requiredScaffolding === "none") {
    return [];
  }

  const violations: string[] = [];

  if (!entry.hasModuleContract) {
    violations.push("missing MODULE_CONTRACT");
  } else {
    if (!entry.hasPurpose) {
      violations.push("purpose missing or < 10 words");
    }
    if (!entry.hasNonGoals) {
      violations.push("no <non-goals> item");
    }
  }

  if (!entry.hasChangeSummary) {
    violations.push("missing CHANGE_SUMMARY");
  }

  if (entry.riskClass === "high" && !entry.hasAiInvariant) {
    violations.push("missing @ai-invariant (high-risk)");
  }

  for (const forbidden of entry.forbiddenPresent) {
    violations.push(`forbidden: ${forbidden} present`);
  }

  return violations;
}

interface CompassBlockParse {
  hasModuleContract: boolean;
  hasKeyDecisions: boolean;
  hasChangeSummary: boolean;
  keyDecisionsItems: string[];
  changeSummaryItems: string[];
  historyIds: string[];
  historyRaw: string | null;
  purposeText: string;
  positions: {
    moduleContract: number;
    keyDecisions: number;
    changeSummary: number;
  };
}

function extractItems(block: string): string[] {
  const items: string[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    items.push(m[1]!.trim());
  }
  return items;
}

function parseCompassBlocks(source: string): CompassBlockParse {
  const positions = {
    moduleContract: source.indexOf("<MODULE_CONTRACT>"),
    keyDecisions: source.indexOf("<KEY_DECISIONS>"),
    changeSummary: source.indexOf("<CHANGE_SUMMARY>"),
  };

  const contractBlock = extractBlockContent(source, "MODULE_CONTRACT");
  const keyDecisionsBlock = extractBlockContent(source, "KEY_DECISIONS");
  const changeSummaryBlock = extractBlockContent(source, "CHANGE_SUMMARY");

  let purposeText = "";
  if (contractBlock) {
    const purposeBlock = extractBlockContent(contractBlock, "purpose");
    if (purposeBlock) {
      purposeText = purposeBlock.replace(/<[^>]+>/g, " ").trim();
    }
  }

  let historyRaw: string | null = null;
  let historyIds: string[] = [];
  if (changeSummaryBlock) {
    const historyMatch = changeSummaryBlock.match(/<history>([\s\S]*?)<\/history>/);
    if (historyMatch) {
      historyRaw = historyMatch[1]!.trim();
      historyIds = historyRaw
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
    }
  }

  return {
    hasModuleContract: positions.moduleContract >= 0,
    hasKeyDecisions: positions.keyDecisions >= 0,
    hasChangeSummary: positions.changeSummary >= 0,
    keyDecisionsItems: keyDecisionsBlock ? extractItems(keyDecisionsBlock) : [],
    changeSummaryItems: changeSummaryBlock ? extractItems(changeSummaryBlock) : [],
    historyIds,
    historyRaw,
    purposeText,
    positions,
  };
}

function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

export function deriveFileTokens(pathFromRoot: string, source: string): Set<string> {
  const segments = pathFromRoot.split("/").filter(Boolean);
  const filename = segments[segments.length - 1] ?? "";
  const dotIndex = filename.lastIndexOf(".");
  const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : "";

  const tokens = new Set<string>();
  for (const segment of stem.split("-").filter(Boolean)) {
    tokens.add(segment.toLowerCase());
  }

  if (SYMBOL_EXTENSIONS.has(extension)) {
    for (const match of source.matchAll(EXPORTED_SYMBOL_RE)) {
      for (const word of splitIdentifier(match[1]!)) {
        tokens.add(word);
      }
    }
  }

  if (GENERIC_STEMS.has(stem.toLowerCase())) {
    const parent = segments[segments.length - 2] ?? "";
    for (const segment of parent.split("-").filter(Boolean)) {
      tokens.add(segment.toLowerCase());
    }
  }

  return tokens;
}

function validateHistoryIds(historyIds: string[]): string | null {
  for (const token of historyIds) {
    if (!HISTORY_ID_RE.test(token)) {
      return `<history> contains a non-ID token: "${token}"`;
    }
  }
  if (new Set(historyIds).size !== historyIds.length) {
    return "<history> contains duplicate IDs";
  }
  const lastSeenByNamespace = new Map<string, number>();
  for (const token of historyIds) {
    const parts = token.match(HISTORY_ID_PARTS_RE)!;
    const namespace = parts[1]!.replace(/-$/, "");
    const numeric = Number(parts[3]);
    const last = lastSeenByNamespace.get(namespace);
    if (last !== undefined && numeric <= last) {
      return `<history> IDs are not in per-namespace ascending numeric order (${token} after ${namespace}-${last})`;
    }
    lastSeenByNamespace.set(namespace, numeric);
  }
  return null;
}

export function evaluateV2Rules(
  entry: Pick<CompassInventoryEntry, "path" | "keyDecisionsRequired">,
  source: string,
): CompassV2Diagnostic[] {
  const parse = parseCompassBlocks(source);
  const diagnostics: CompassV2Diagnostic[] = [];

  const orderedPositions = [
    parse.positions.moduleContract,
    parse.positions.keyDecisions,
    parse.positions.changeSummary,
  ].filter((position) => position >= 0);
  if (orderedPositions.length >= 2) {
    const sorted = [...orderedPositions].sort((a, b) => a - b);
    const inOrder = orderedPositions.every((position, index) => position === sorted[index]);
    if (!inOrder) {
      diagnostics.push({
        ruleId: "COMPASS-ORDER-01",
        message:
          "Compass blocks out of canonical order (MODULE_CONTRACT → KEY_DECISIONS → CHANGE_SUMMARY)",
        fix: "fix: reorder blocks to MODULE_CONTRACT, KEY_DECISIONS, CHANGE_SUMMARY",
      });
    }
  }

  if (entry.keyDecisionsRequired && !parse.hasKeyDecisions) {
    diagnostics.push({
      ruleId: "COMPASS-KD-01",
      message: "missing KEY_DECISIONS (required for medium/high riskClass)",
      fix: "fix: add a KEY_DECISIONS block with 1-7 current-state design items",
    });
  }
  if (parse.hasKeyDecisions) {
    const items = parse.keyDecisionsItems;
    const realItems = items.filter((item) => item.length > 0 && !TODO_PLACEHOLDER_RE.test(item));
    if (items.length === 0 || realItems.length === 0) {
      diagnostics.push({
        ruleId: "COMPASS-KD-02",
        message: "KEY_DECISIONS block is empty or contains only TODO placeholder items",
        fix: "fix: write real current-state decisions or remove the block",
      });
    }
    for (const item of items) {
      if (countWords(item) > KEY_DECISIONS_MAX_WORDS) {
        diagnostics.push({
          ruleId: "COMPASS-KD-03",
          message: `KEY_DECISIONS item exceeds ${KEY_DECISIONS_MAX_WORDS} words`,
          fix: "fix: compress the item to a single decision statement",
        });
      }
      if (GOVERNANCE_ID_PREFIX_RE.test(item)) {
        diagnostics.push({
          ruleId: "COMPASS-KD-05",
          message:
            "KEY_DECISIONS item starts with a governance-ID prefix — history belongs in CHANGE_SUMMARY",
          fix: "fix: rewrite the item as a current-state decision without an ID prefix",
        });
      }
    }
    if (items.length > KEY_DECISIONS_MAX_ITEMS) {
      diagnostics.push({
        ruleId: "COMPASS-KD-04",
        message: `KEY_DECISIONS has ${items.length} items (cap is ${KEY_DECISIONS_MAX_ITEMS})`,
        fix: "fix: keep only the decisions that still govern the file",
      });
    }
  }

  if (parse.purposeText.length > 0) {
    if (PURPOSE_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(parse.purposeText))) {
      diagnostics.push({
        ruleId: "COMPASS-PURPOSE-01",
        message: "<purpose> matches a boilerplate pattern",
        fix: "fix: write a specific purpose naming what this file does",
      });
    }
    const tokens = deriveFileTokens(entry.path, source);
    const purposeWords = new Set(
      parse.purposeText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    const hasToken = [...tokens].some((token) => purposeWords.has(token));
    if (!hasToken) {
      diagnostics.push({
        ruleId: "COMPASS-PURPOSE-02",
        message: "<purpose> contains no file-derived token (stem, parent dir, or exported symbol)",
        fix: "fix: mention the file's own name or an exported symbol in <purpose>",
      });
    }
  }

  if (parse.hasChangeSummary) {
    if (parse.changeSummaryItems.length > CHANGE_SUMMARY_MAX_ITEMS) {
      diagnostics.push({
        ruleId: "COMPASS-CS-05",
        message: `CHANGE_SUMMARY has ${parse.changeSummaryItems.length} items (cap is ${CHANGE_SUMMARY_MAX_ITEMS}); collapse oldest into <history>`,
        fix: "fix: keep the 5 newest items and collapse older IDs into <history>",
      });
    }
    for (const item of parse.changeSummaryItems) {
      if (!GOVERNANCE_ID_RE.test(item)) {
        diagnostics.push({
          ruleId: "COMPASS-CS-06",
          message: `CHANGE_SUMMARY item lacks a governance-ID reference: "${item.slice(0, 60)}"`,
          fix: "fix: prefix the item with its RFC/ADR/ticket ID or remove it",
        });
      }
    }
    if (parse.historyRaw !== null) {
      const historyError = validateHistoryIds(parse.historyIds);
      if (historyError) {
        diagnostics.push({
          ruleId: "COMPASS-CS-07",
          message: historyError,
          fix: "fix: <history> carries comma-separated governance IDs only, deduplicated, per-namespace ascending",
        });
      }
    }
  }

  return diagnostics;
}

function detectMarkup(source: string) {
  const parse = parseCompassBlocks(source);
  const hasAiInvariant = /@ai-invariant\b/.test(source);

  const hasPurpose = countWords(parse.purposeText) >= 10;
  let hasNonGoals = false;

  if (parse.hasModuleContract) {
    const contractBlock = extractBlockContent(source, "MODULE_CONTRACT");
    if (contractBlock) {
      const nonGoalsBlock = extractBlockContent(contractBlock, "non-goals");
      if (nonGoalsBlock) {
        hasNonGoals = (nonGoalsBlock.match(/<item>/g) ?? []).length >= 1;
      }
    }
  }

  const forbiddenPresent: string[] = [];
  for (const { name, regex } of FORBIDDEN_PATTERNS) {
    if (regex.test(source)) {
      forbiddenPresent.push(name);
    }
  }

  return {
    hasModuleContract: parse.hasModuleContract,
    hasChangeSummary: parse.hasChangeSummary,
    hasKeyDecisions: parse.hasKeyDecisions,
    keyDecisionsItemCount: parse.keyDecisionsItems.length,
    changeSummaryItemCount: parse.changeSummaryItems.length,
    historyIds: parse.historyIds,
    hasAiInvariant,
    hasPurpose,
    hasNonGoals,
    forbiddenPresent,
  };
}

const entrySources = new WeakMap<CompassInventoryEntry, string>();

/** Returns the source text captured during `createCompassInventoryEntries`, if still cached. */
export function getEntrySource(entry: CompassInventoryEntry): string | undefined {
  return entrySources.get(entry);
}

export async function createCompassInventoryEntries(
  workspaceRoot: string,
  input: ForgeCommandInput,
  scanRoot?: string,
): Promise<CompassInventoryEntry[]> {
  const roots = scanRoot ? [scanRoot] : resolveScanRoots(workspaceRoot, input);
  const extraExtensions = loadCompassExtensionsFromForgeYaml(workspaceRoot);
  const files = (
    await Promise.all(roots.map((root) => collectSourceFiles(root, extraExtensions)))
  ).flat();
  const entries: CompassInventoryEntry[] = [];

  for (const filePath of files.sort()) {
    const source = await readFile(filePath, "utf8");
    const pathFromRoot = relative(workspaceRoot, filePath).replace(/\\/g, "/");
    const segments = getRelativeSegments(filePath, workspaceRoot);
    const relativePathWithinWorkspace = getWorkspaceRelativeSegments(segments).join("/");
    const layer = detectLayer(relativePathWithinWorkspace);
    const riskClass = detectRiskClass(pathFromRoot, layer);
    const complexity = detectComplexity(source);
    const { authoringStatus, exclusionReason } = detectAuthoringStatus(
      segments,
      relativePathWithinWorkspace,
      source,
    );
    const requiredScaffolding = detectRequiredScaffolding(authoringStatus);
    const markup = detectMarkup(source);
    const keyDecisionsRequired =
      authoringStatus === "authored" &&
      requiredScaffolding === "standard" &&
      (riskClass === "medium" || riskClass === "high");
    const nonEmptyLineCount = source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    const candidate: CompassInventoryEntry = {
      path: pathFromRoot,
      workspaceKind: detectWorkspaceKind(segments),
      workspaceName: detectWorkspaceName(segments),
      layer,
      extension:
        segments.length > 0
          ? segments[segments.length - 1]!.slice(segments[segments.length - 1]!.lastIndexOf("."))
          : "",
      authoringStatus,
      exclusionReason,
      riskClass,
      complexity,
      requiredScaffolding,
      nonEmptyLineCount,
      hasModuleContract: markup.hasModuleContract,
      hasChangeSummary: markup.hasChangeSummary,
      hasKeyDecisions: markup.hasKeyDecisions,
      keyDecisionsItemCount: markup.keyDecisionsItemCount,
      keyDecisionsRequired,
      changeSummaryItemCount: markup.changeSummaryItemCount,
      historyIds: markup.historyIds,
      hasAiInvariant: markup.hasAiInvariant,
      hasPurpose: markup.hasPurpose,
      hasNonGoals: markup.hasNonGoals,
      forbiddenPresent: markup.forbiddenPresent,
      compliant: false,
      violations: [],
    };
    candidate.violations = detectComplianceViolations(candidate);
    candidate.compliant = candidate.violations.length === 0;
    entrySources.set(candidate, source);
    entries.push(candidate);
  }

  return entries;
}
