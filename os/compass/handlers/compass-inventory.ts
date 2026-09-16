/*
<MODULE_CONTRACT>
<purpose>Canonical Compass inventory scanning logic. Moved from the legacy site
kernel package to @warpgogol/forge for full autonomous mode (RFC-0556). Provides file collection,
workspace detection, layer classification, risk assessment, and compliance checking
for Compass source-file inventory.</purpose>
<non-goals>
  <item>Do not render XML output — that belongs in the compass command handler.</item>
  <item>Do not register commands — this is a pure utility module.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0556: moved canonical implementation from the legacy site kernel package to @warpgogol/forge for autonomous mode.</item>
  <item>Game extensions: added .cs, .tscn, .tres, .gd to SOURCE_EXTENSIONS; createCompassInventoryEntries now reads forge.yaml compass.fileExtensions at runtime and merges with hardcoded set.</item>
  <item>Added .md to SOURCE_EXTENSIONS for SKILL.md Compass coverage; detectAuthoringStatus excludes non-SKILL.md markdown files.</item>
  <item>RFC-1094: v2 contract — KEY_DECISIONS/history parsing, new inventory fields, evaluateV2Rules, deriveFileTokens, resolveCompassMode, shared GOVERNANCE_ID_RE.</item>
  <item>RFC-1095: compass.summary.record, trim repair rewrite, commit integration</item>
  <item>RFC-1096: all policy literals externalized to resolveCompassPolicy — scan roots, extensions, ignored dirs/paths, layer/risk rules, governance-ID and boilerplate patterns come from generic defaults + profile + bindings.compass.</item>
  <history>RFC-0348</history>
</CHANGE_SUMMARY>
*/

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ForgeCommandInput } from "../../../src/types.ts";
import { hasGeneratedMarker } from "../../../src/utils/generated-marker.ts";
import {
  parseGovernanceIdParts,
  resolveCompassPolicy,
  type CompassPolicy,
  type CompassRiskClass,
  type CompassWorkspaceKind,
} from "../policy.ts";

function forbiddenMarkerPattern(tagName: string): RegExp {
  return new RegExp(`<${tagName}\\b`);
}

const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "MODULE_MAP", regex: forbiddenMarkerPattern("MODULE_MAP") },
  { name: "keywords", regex: forbiddenMarkerPattern("keywords") },
  { name: "responsibilities", regex: forbiddenMarkerPattern("responsibilities") },
  { name: "COMPASS_BLOCK", regex: new RegExp(`</?${"COMPASS_BLOCK"}\\b`) },
];

// RFC-1096: governance-ID regexes are policy-derived (policy.idPattern*).
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

function resolveScanRoots(
  workspaceRoot: string,
  input: ForgeCommandInput,
  policy: CompassPolicy,
): string[] {
  const values = getFlagValues(input, "root");
  const roots = values.length > 0 ? values : policy.scanRoots;
  return roots.map((value) => resolve(workspaceRoot, value));
}

function shouldIgnoreDirectory(name: string, policy: CompassPolicy): boolean {
  if (policy.ignoredDirs.has(name)) {
    return true;
  }
  return policy.ignoredDirPrefixes.some((prefix) => name.startsWith(prefix));
}

function hasRelevantExtension(filePath: string, policy: CompassPolicy): boolean {
  for (const extension of policy.fileExtensions) {
    if (filePath.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

async function collectSourceFiles(targetPath: string, policy: CompassPolicy): Promise<string[]> {
  let stat;
  try {
    const { stat: fsStat } = await import("node:fs/promises");
    stat = await fsStat(targetPath);
  } catch {
    return [];
  }

  if (stat.isFile()) {
    return hasRelevantExtension(targetPath, policy) ? [targetPath] : [];
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
      if (shouldIgnoreDirectory(entry.name, policy)) {
        continue;
      }

      files.push(...(await collectSourceFiles(absolutePath, policy)));
      continue;
    }

    if (entry.isFile() && hasRelevantExtension(absolutePath, policy)) {
      files.push(absolutePath);
    }
  }

  return files;
}

export function getRelativeSegments(filePath: string, workspaceRoot: string): string[] {
  return relative(workspaceRoot, filePath).replace(/\\/g, "/").split("/").filter(Boolean);
}

function isWorkspaceDir(segment: string | undefined, policy: CompassPolicy): boolean {
  return segment !== undefined && segment in policy.workspaceKinds;
}

function detectWorkspaceKind(segments: string[], policy: CompassPolicy): CompassWorkspaceKind {
  const first = segments[0];
  return (first !== undefined && policy.workspaceKinds[first]) || "app";
}

function detectWorkspaceName(segments: string[], policy: CompassPolicy): string {
  if (isWorkspaceDir(segments[0], policy)) {
    return segments[1] ?? "unknown";
  }
  // Files outside any workspace dir (e.g. tools/*) report "root" rather than
  // leaking a filename into the workspace-name slot.
  return "root";
}

export function getWorkspaceRelativeSegments(segments: string[], policy: CompassPolicy): string[] {
  if (isWorkspaceDir(segments[0], policy)) {
    return segments.slice(2);
  }
  return segments;
}

export function detectLayer(relativePath: string, policy: CompassPolicy): string {
  return policy.matchLayer(relativePath)?.layer ?? "other";
}

export function detectRiskClass(
  pathFromRoot: string,
  workspaceRelativePath: string,
  policy: CompassPolicy,
): CompassRiskClass {
  if (policy.isHighRisk(pathFromRoot)) {
    return "high";
  }
  return policy.matchLayer(workspaceRelativePath)?.risk ?? "low";
}

function detectComplexity(source: string): CompassComplexity {
  const nonEmptyLineCount = source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  if (nonEmptyLineCount <= 20 && source.length <= 900) {
    return "trivial";
  }
  return "non-trivial";
}

function detectAuthoringStatus(
  segments: string[],
  relativePath: string,
  source: string,
  policy: CompassPolicy,
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

  const policyExclusion = policy.excludedReason(relativePath);
  if (policyExclusion !== undefined) {
    return {
      authoringStatus: "excluded",
      exclusionReason: policyExclusion,
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

  if (policy.isTestPath(relativePath)) {
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

function validateHistoryIds(historyIds: string[], policy: CompassPolicy): string | null {
  for (const token of historyIds) {
    if (!policy.idPatternFull.test(token)) {
      return `<history> contains a non-ID token: "${token}"`;
    }
  }
  if (new Set(historyIds).size !== historyIds.length) {
    return "<history> contains duplicate IDs";
  }
  const lastSeenByNamespace = new Map<string, number>();
  for (const token of historyIds) {
    const parts = parseGovernanceIdParts(token)!;
    const last = lastSeenByNamespace.get(parts.namespace);
    if (last !== undefined && parts.numeric <= last) {
      return `<history> IDs are not in per-namespace ascending numeric order (${token} after ${parts.namespace}-${last})`;
    }
    lastSeenByNamespace.set(parts.namespace, parts.numeric);
  }
  return null;
}

export function evaluateV2Rules(
  entry: Pick<CompassInventoryEntry, "path" | "keyDecisionsRequired">,
  source: string,
  policy: CompassPolicy,
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
      if (policy.idPatternPrefix.test(item)) {
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
    if (policy.purposeBoilerplatePatterns.some((pattern) => pattern.test(parse.purposeText))) {
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
      if (!policy.idPattern.test(item)) {
        diagnostics.push({
          ruleId: "COMPASS-CS-06",
          message: `CHANGE_SUMMARY item lacks a governance-ID reference: "${item.slice(0, 60)}"`,
          fix: "fix: prefix the item with its RFC/ADR/ticket ID or remove it",
        });
      }
    }
    if (parse.historyRaw !== null) {
      const historyError = validateHistoryIds(parse.historyIds, policy);
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
  policy?: CompassPolicy,
): Promise<CompassInventoryEntry[]> {
  const resolvedPolicy = policy ?? resolveCompassPolicy(workspaceRoot);
  const roots = scanRoot ? [scanRoot] : resolveScanRoots(workspaceRoot, input, resolvedPolicy);
  const files = (
    await Promise.all(roots.map((root) => collectSourceFiles(root, resolvedPolicy)))
  ).flat();
  const entries: CompassInventoryEntry[] = [];

  for (const filePath of files.sort()) {
    const source = await readFile(filePath, "utf8");
    const pathFromRoot = relative(workspaceRoot, filePath).replace(/\\/g, "/");
    const segments = getRelativeSegments(filePath, workspaceRoot);
    const relativePathWithinWorkspace = getWorkspaceRelativeSegments(segments, resolvedPolicy).join(
      "/",
    );
    const layer = detectLayer(relativePathWithinWorkspace, resolvedPolicy);
    const riskClass = detectRiskClass(pathFromRoot, relativePathWithinWorkspace, resolvedPolicy);
    const complexity = detectComplexity(source);
    const { authoringStatus, exclusionReason } = detectAuthoringStatus(
      segments,
      relativePathWithinWorkspace,
      source,
      resolvedPolicy,
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
      workspaceKind: detectWorkspaceKind(segments, resolvedPolicy),
      workspaceName: detectWorkspaceName(segments, resolvedPolicy),
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
