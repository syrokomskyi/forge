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
  <item>RFC-0348: collapsed to two-block contract (MODULE_CONTRACT + CHANGE_SUMMARY); removed MODULE_MAP, keywords, responsibilities, COMPASS_BLOCK anchors; coverage modes collapsed to standard/none.</item>
  <item>Post-refactor hardening: exclude src/templates generation inputs from authored Compass requirements.</item>
  <item>Post-refactor hardening: detect nested packages/os workspaces before deriving Compass layer and workspace name.</item>
  <item>RFC-0556: moved canonical implementation from @warpgogol/site-kernel to @warpgogol/forge for autonomous mode.</item>
</CHANGE_SUMMARY>
*/

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ForgeCommandInput } from "../../../src/types.ts";
import { hasGeneratedMarker } from "../../../src/utils/generated-marker.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".astro", ".js", ".jsx", ".mjs", ".mts", ".css"]);
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
const REQUIRED_MARKERS = ["<MODULE_CONTRACT>", "<CHANGE_SUMMARY>"] as const;
function forbiddenMarkerPattern(tagName: string): RegExp {
  return new RegExp(`<${tagName}\\b`);
}

const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "MODULE_MAP", regex: forbiddenMarkerPattern("MODULE_MAP") },
  { name: "keywords", regex: forbiddenMarkerPattern("keywords") },
  { name: "responsibilities", regex: forbiddenMarkerPattern("responsibilities") },
  { name: "COMPASS_BLOCK", regex: new RegExp(`</?${"COMPASS_BLOCK"}\\b`) },
];

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

function hasRelevantExtension(filePath: string): boolean {
  for (const extension of SOURCE_EXTENSIONS) {
    if (filePath.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

async function collectSourceFiles(targetPath: string): Promise<string[]> {
  let stat;
  try {
    const { stat: fsStat } = await import("node:fs/promises");
    stat = await fsStat(targetPath);
  } catch {
    return [];
  }

  if (stat.isFile()) {
    return hasRelevantExtension(targetPath) ? [targetPath] : [];
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

      files.push(...(await collectSourceFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && hasRelevantExtension(absolutePath)) {
      files.push(absolutePath);
    }
  }

  return files;
}

function getRelativeSegments(filePath: string, workspaceRoot: string): string[] {
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

function getWorkspaceRelativeSegments(segments: string[]): string[] {
  if (segments[0] === "packages" && segments[1] === "os") {
    return segments.slice(3);
  }
  return segments.slice(2);
}

function detectLayer(relativePath: string): string {
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
  return "other";
}

function detectRiskClass(pathFromRoot: string, layer: string): CompassRiskClass {
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

function detectMarkup(source: string) {
  const hasModuleContract = source.includes(REQUIRED_MARKERS[0]);
  const hasChangeSummary = source.includes(REQUIRED_MARKERS[1]);
  const hasAiInvariant = /@ai-invariant\b/.test(source);

  let hasPurpose = false;
  let hasNonGoals = false;

  if (hasModuleContract) {
    const contractBlock = extractBlockContent(source, "MODULE_CONTRACT");
    if (contractBlock) {
      const purposeBlock = extractBlockContent(contractBlock, "purpose");
      if (purposeBlock) {
        const purposeText = purposeBlock.replace(/<[^>]+>/g, " ");
        hasPurpose = countWords(purposeText) >= 10;
      }

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
    hasModuleContract,
    hasChangeSummary,
    hasAiInvariant,
    hasPurpose,
    hasNonGoals,
    forbiddenPresent,
  };
}

export async function createCompassInventoryEntries(
  workspaceRoot: string,
  input: ForgeCommandInput,
  scanRoot?: string,
): Promise<CompassInventoryEntry[]> {
  const roots = scanRoot ? [scanRoot] : resolveScanRoots(workspaceRoot, input);
  const files = (await Promise.all(roots.map((root) => collectSourceFiles(root)))).flat();
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
      hasAiInvariant: markup.hasAiInvariant,
      hasPurpose: markup.hasPurpose,
      hasNonGoals: markup.hasNonGoals,
      forbiddenPresent: markup.forbiddenPresent,
      compliant: false,
      violations: [],
    };
    candidate.violations = detectComplianceViolations(candidate);
    candidate.compliant = candidate.violations.length === 0;
    entries.push(candidate);
  }

  return entries;
}
