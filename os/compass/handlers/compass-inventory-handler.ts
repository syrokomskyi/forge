/*
<MODULE_CONTRACT>
<purpose>Compass inventory and validation command handlers. Moved from
@warpgogol/site-kernel-checks to @warpgogol/forge for full autonomous mode (RFC-0556).
Provides runCompassInventory (XML report generation) and runCompassValidation
(compliance diagnostics with COMPASS-* rules). RFC-0943: validates pack-declared
contract block specs alongside built-in MODULE_CONTRACT and CHANGE_SUMMARY checks.</purpose>
<non-goals>
  <item>Do not handle raw file parsing or content analysis.</item>
  <item>Do not manage configuration or orchestration of external services.</item>
  <item>Do not execute pack-provided validate() functions — pack block specs are declarative data interpreted here.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0348: v2 two-block contract — XML output updated, compass.validate emits COMPASS-* diagnostics, summary uses standard-required-files.</item>
  <item>RFC-0350: added COMPASS-TODO-01 diagnostic for unfilled Compass TODO sentinels.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-checks to @warpgogol/forge for autonomous mode.</item>
  <item>Game extensions: added COMPASS-SYNTAX-01 diagnostic validating comment syntax per file type (.gd needs # prefix, .tscn/.tres need ; prefix, .ts/.cs need block comment).</item>
  <item>RFC-0943: added COMPASS-PLUGIN-01/02/03 diagnostics for pack-declared contract block specs from forge.plugin.yaml extensionPoints.</item>
</CHANGE_SUMMARY>
*/

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createCompassInventoryEntries, type CompassInventoryEntry } from "./compass-inventory.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import { loadForgeConfig } from "../../../src/config/forge-config.ts";
import {
  loadContractRegistry,
  findApplicablePackSpecs,
} from "../../../src/compass/contract-registry.ts";
import type {
  CompassContractBlockSpec,
  CompassContractRegistryEntry,
} from "../../../src/compass/types.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

function extractBlockContentForPlugin(source: string, tagName: string): string | null {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`<${escapedTag}>[\\s\\S]*?<\/${escapedTag}>`));
  return match?.[0] ?? null;
}

const INVENTORY_OUTPUT_PATH = "docs/compass-inventory.xml";

function getExpectedCommentSyntax(filePath: string): "block" | "hash" | "semicolon" | null {
  if (filePath.endsWith(".gd")) return "hash";
  if (filePath.endsWith(".tscn") || filePath.endsWith(".tres")) return "semicolon";
  if (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".js") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".mts") ||
    filePath.endsWith(".css") ||
    filePath.endsWith(".cs")
  )
    return "block";
  return null;
}

function checkCommentSyntax(source: string, filePath: string): string | null {
  const syntax = getExpectedCommentSyntax(filePath);
  if (!syntax) return null;

  const hasModuleContract = source.includes("<MODULE_CONTRACT>");
  if (!hasModuleContract) return null;

  if (syntax === "block") {
    const blockStart = source.indexOf("/*");
    const blockEnd = source.lastIndexOf("*/");
    const tagPos = source.indexOf("<MODULE_CONTRACT>");
    if (blockStart === -1 || blockEnd === -1 || blockStart > tagPos || tagPos > blockEnd) {
      return "MODULE_CONTRACT must be inside a /* ... */ block comment for this file type";
    }
  } else if (syntax === "hash") {
    const lines = source.split(/\r?\n/);
    for (const line of lines) {
      if (line.includes("<MODULE_CONTRACT>")) {
        if (!line.trimStart().startsWith("# ")) {
          return "MODULE_CONTRACT lines must be prefixed with '# ' for .gd files";
        }
      }
    }
  } else if (syntax === "semicolon") {
    const lines = source.split(/\r?\n/);
    for (const line of lines) {
      if (line.includes("<MODULE_CONTRACT>")) {
        if (!line.trimStart().startsWith("; ")) {
          return "MODULE_CONTRACT lines must be prefixed with '; ' for .tscn/.tres files";
        }
      }
    }
  }
  return null;
}

interface CompassInventorySummary {
  scannedFiles: number;
  authoredFiles: number;
  excludedFiles: number;
  standardRequiredFiles: number;
  compliantFiles: number;
  nonCompliantFiles: number;
}

function summarizeInventory(entries: CompassInventoryEntry[]): CompassInventorySummary {
  let authoredFiles = 0;
  let excludedFiles = 0;
  let standardRequiredFiles = 0;
  let compliantFiles = 0;
  let nonCompliantFiles = 0;

  for (const entry of entries) {
    if (entry.authoringStatus === "excluded") {
      excludedFiles += 1;
      continue;
    }

    authoredFiles += 1;
    if (entry.requiredScaffolding === "standard") standardRequiredFiles += 1;

    if (entry.compliant) {
      compliantFiles += 1;
    } else {
      nonCompliantFiles += 1;
    }
  }

  return {
    scannedFiles: entries.length,
    authoredFiles,
    excludedFiles,
    standardRequiredFiles,
    compliantFiles,
    nonCompliantFiles,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderInventoryXml(
  entries: CompassInventoryEntry[],
  summary: CompassInventorySummary,
): string {
  const lines: string[] = [];
  lines.push("<compass-inventory>");
  lines.push("  <meta>");
  lines.push("    <document-id>compass-inventory</document-id>");
  lines.push("    <version>2.0.0</version>");
  lines.push("    <status>generated</status>");
  lines.push("    <scope>repository-root</scope>");
  lines.push(`    <generated-at>null</generated-at>`);
  lines.push("    <generator>@warpgogol/forge:compass.inventory</generator>");
  lines.push("  </meta>");
  lines.push("  <summary>");
  lines.push(`    <scanned-files>${summary.scannedFiles}</scanned-files>`);
  lines.push(`    <authored-files>${summary.authoredFiles}</authored-files>`);
  lines.push(`    <excluded-files>${summary.excludedFiles}</excluded-files>`);
  lines.push(
    `    <standard-required-files>${summary.standardRequiredFiles}</standard-required-files>`,
  );
  lines.push(`    <compliant-files>${summary.compliantFiles}</compliant-files>`);
  lines.push(`    <non-compliant-files>${summary.nonCompliantFiles}</non-compliant-files>`);
  lines.push("  </summary>");
  lines.push("  <entries>");

  for (const entry of entries) {
    lines.push(
      `    <entry path="${escapeXml(entry.path)}" workspace-kind="${entry.workspaceKind}" workspace-name="${escapeXml(entry.workspaceName)}" layer="${escapeXml(entry.layer)}" extension="${escapeXml(entry.extension)}" authoring-status="${entry.authoringStatus}" risk-class="${entry.riskClass}" complexity="${entry.complexity}" required-scaffolding="${entry.requiredScaffolding}" compliant="${entry.compliant ? "true" : "false"}">`,
    );
    lines.push(`      <non-empty-lines>${entry.nonEmptyLineCount}</non-empty-lines>`);
    if (entry.exclusionReason) {
      lines.push(`      <exclusion-reason>${escapeXml(entry.exclusionReason)}</exclusion-reason>`);
    }
    lines.push(
      `      <has-module-contract>${entry.hasModuleContract ? "true" : "false"}</has-module-contract>`,
    );
    lines.push(
      `      <has-change-summary>${entry.hasChangeSummary ? "true" : "false"}</has-change-summary>`,
    );
    lines.push(
      `      <has-ai-invariant>${entry.hasAiInvariant ? "true" : "false"}</has-ai-invariant>`,
    );
    lines.push(`      <has-purpose>${entry.hasPurpose ? "true" : "false"}</has-purpose>`);
    lines.push(`      <has-non-goals>${entry.hasNonGoals ? "true" : "false"}</has-non-goals>`);
    if (entry.forbiddenPresent.length > 0) {
      lines.push("      <forbidden-markers>");
      for (const marker of entry.forbiddenPresent) {
        lines.push(`        <marker>${escapeXml(marker)}</marker>`);
      }
      lines.push("      </forbidden-markers>");
    }
    if (entry.violations.length > 0) {
      lines.push("      <violations>");
      for (const violation of entry.violations) {
        lines.push(`        <violation>${escapeXml(violation)}</violation>`);
      }
      lines.push("      </violations>");
    }
    lines.push("    </entry>");
  }

  lines.push("  </entries>");
  lines.push("</compass-inventory>");
  lines.push("");
  return lines.join("\n");
}

export async function runCompassInventory(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{ entries: number; outputPath: string; summary: CompassInventorySummary }>
> {
  const scanRoot = resolveCompassScanRoot(input, context) ?? context.workspaceRoot;
  const entries = await createCompassInventoryEntries(scanRoot, input);
  const summary = summarizeInventory(entries);

  context.logger.info(
    `[compass.inventory] scanned=${summary.scannedFiles} authored=${summary.authoredFiles} excluded=${summary.excludedFiles} standard=${summary.standardRequiredFiles}`,
  );

  if (context.dryRun) {
    context.logger.warn(
      `[compass.inventory] dry-run active — skipped writing ${INVENTORY_OUTPUT_PATH}`,
    );
    return {
      data: { entries: entries.length, outputPath: INVENTORY_OUTPUT_PATH, summary },
      summary: `[compass.inventory] previewed ${INVENTORY_OUTPUT_PATH}`,
      nextSteps: [
        {
          action: `Write the inventory: pnpm exec forge run compass.inventory`,
          kind: "optional",
        },
      ],
    };
  }

  const xml = renderInventoryXml(entries, summary);
  const outputPath = resolve(context.workspaceRoot, INVENTORY_OUTPUT_PATH);
  await writeFileIfChanged(outputPath, xml);

  return {
    data: { entries: entries.length, outputPath, summary },
    summary: `[compass.inventory] ${context.dryRun ? "previewed" : "wrote"} ${INVENTORY_OUTPUT_PATH}`,
    nextSteps: context.dryRun
      ? [
          {
            action: `Write for real: pnpm exec forge run compass.inventory`,
            kind: "optional",
          },
        ]
      : [
          {
            action: `Validate compass headers: pnpm exec forge run compass.validate`,
            kind: "optional",
          },
        ],
  };
}

export async function runCompassValidation(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    checkedFiles: number;
    failures: number;
    summary: CompassInventorySummary;
    diagnostics: Array<{
      ruleId: string;
      severity: string;
      file: string;
      message: string;
      fix: string;
    }>;
  }>
> {
  const scanRoot = resolveCompassScanRoot(input, context);
  const entries = await createCompassInventoryEntries(context.workspaceRoot, input, scanRoot);
  const summary = summarizeInventory(entries);
  const failures = entries.filter(
    (entry) =>
      entry.authoringStatus === "authored" &&
      entry.requiredScaffolding !== "none" &&
      !entry.compliant,
  );

  const diagnostics: Array<{
    ruleId: string;
    severity: string;
    file: string;
    message: string;
    fix: string;
    pack?: string;
  }> = [];

  for (const failure of failures) {
    for (const violation of failure.violations) {
      let ruleId = "COMPASS-CONTRACT-01";
      let fix = "fix: add a MODULE_CONTRACT block with <purpose> and <non-goals>";

      if (violation.includes("purpose missing")) {
        ruleId = "COMPASS-CONTRACT-02";
        fix = "fix: write a <purpose> of at least 10 words";
      } else if (violation.includes("non-goals")) {
        ruleId = "COMPASS-CONTRACT-03";
        fix = "fix: add at least one <non-goals><item>";
      } else if (violation.includes("CHANGE_SUMMARY")) {
        ruleId = "COMPASS-CONTRACT-04";
        fix = "fix: add a CHANGE_SUMMARY with at least one <item>";
      } else if (violation.includes("@ai-invariant")) {
        ruleId = "COMPASS-INVARIANT-01";
        fix = "fix: add // @ai-invariant capturing the non-obvious constraint";
      } else if (violation.includes("forbidden")) {
        ruleId = "COMPASS-FORBIDDEN-01";
        const marker = violation.replace(/forbidden: ([^ ]+) present/, "$1");
        fix = `fix: remove ${marker}; run fo-compass-annotate skill`;
      }

      context.logger.error(`[compass.validate] ${ruleId}: ${failure.path}: ${violation}`);
      diagnostics.push({
        ruleId,
        severity: "error",
        file: failure.path,
        message: violation,
        fix,
      });
    }
  }

  const compassTodoLabel = "TODO" + "(compass)";
  const TODO_COMPASS_RE = new RegExp("TODO" + "\\\\(compass\\\\)");
  for (const entry of entries) {
    if (entry.authoringStatus !== "authored" || entry.requiredScaffolding === "none") {
      continue;
    }
    if (!entry.hasModuleContract && !entry.hasChangeSummary) {
      continue;
    }

    const absPath = resolve(context.workspaceRoot, entry.path);
    const source = await readFile(absPath, "utf8");
    if (TODO_COMPASS_RE.test(source)) {
      context.logger.error(
        `[compass.validate] COMPASS-TODO-01: ${entry.path}: unfilled ${compassTodoLabel} sentinel in Compass block`,
      );
      diagnostics.push({
        ruleId: "COMPASS-TODO-01",
        severity: "error",
        file: entry.path,
        message: `Unfilled ${compassTodoLabel} sentinel in Compass block`,
        fix: `fix: replace the ${compassTodoLabel} sentinel with a real value`,
      });
    }

    const syntaxError = checkCommentSyntax(source, entry.path);
    if (syntaxError) {
      context.logger.error(`[compass.validate] COMPASS-SYNTAX-01: ${entry.path}: ${syntaxError}`);
      diagnostics.push({
        ruleId: "COMPASS-SYNTAX-01",
        severity: "error",
        file: entry.path,
        message: syntaxError,
        fix: "fix: use the correct comment syntax for this file type (see comment-styles.md)",
      });
    }
  }

  let registry: {
    builtIn: CompassContractBlockSpec[];
    pack: CompassContractRegistryEntry[];
  } = { builtIn: [], pack: [] };
  try {
    const config = loadForgeConfig(context.workspaceRoot, context.forgeRoot);
    registry = loadContractRegistry(context.workspaceRoot, config);
  } catch {
    // No forge.yaml or invalid config — skip pack-declared blocks
  }
  if (registry.pack.length > 0) {
    for (const entry of entries) {
      if (entry.authoringStatus !== "authored" || entry.requiredScaffolding === "none") {
        continue;
      }

      const applicableSpecs = findApplicablePackSpecs(registry, entry.path);
      if (applicableSpecs.length === 0) continue;

      const absPath = resolve(context.workspaceRoot, entry.path);
      const source = await readFile(absPath, "utf8");

      for (const spec of applicableSpecs) {
        const blockMarker = `<${spec.blockId.toUpperCase().replace(/-/g, "_")}>`;
        if (!source.includes(blockMarker)) {
          context.logger.error(
            `[compass.validate] COMPASS-PLUGIN-01: ${entry.path}: missing ${spec.blockId} block (declared by pack ${spec.packId})`,
          );
          diagnostics.push({
            ruleId: "COMPASS-PLUGIN-01",
            severity: "error",
            file: entry.path,
            message: `missing ${spec.blockId} block (declared by pack ${spec.packId})`,
            fix: `fix: add a ${blockMarker} block to this file`,
            pack: spec.packId,
          });
          continue;
        }

        if (spec.requiredTags && spec.requiredTags.length > 0) {
          const blockContent = extractBlockContentForPlugin(
            source,
            spec.blockId.toUpperCase().replace(/-/g, "_"),
          );
          for (const tag of spec.requiredTags) {
            const tagMarker = `<${tag.name}>`;
            if (!blockContent || !blockContent.includes(tagMarker)) {
              context.logger.error(
                `[compass.validate] COMPASS-PLUGIN-02: ${entry.path}: missing <${tag.name}> tag in ${spec.blockId} block (declared by pack ${spec.packId})`,
              );
              diagnostics.push({
                ruleId: "COMPASS-PLUGIN-02",
                severity: "error",
                file: entry.path,
                message: `missing <${tag.name}> tag in ${spec.blockId} block (declared by pack ${spec.packId})`,
                fix: `fix: add a <${tag.name}> tag inside the ${blockMarker} block`,
                pack: spec.packId,
              });
              continue;
            }

            if (tag.minWords) {
              const tagContent = extractBlockContentForPlugin(blockContent, tag.name);
              if (tagContent) {
                const text = tagContent.replace(/<[^>]+>/g, " ");
                const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
                if (wordCount < tag.minWords) {
                  context.logger.error(
                    `[compass.validate] COMPASS-PLUGIN-03: ${entry.path}: <${tag.name}> in ${spec.blockId} has ${wordCount} words (minimum ${tag.minWords}, declared by pack ${spec.packId})`,
                  );
                  diagnostics.push({
                    ruleId: "COMPASS-PLUGIN-03",
                    severity: "error",
                    file: entry.path,
                    message: `<${tag.name}> in ${spec.blockId} has ${wordCount} words (minimum ${tag.minWords}, declared by pack ${spec.packId})`,
                    fix: `fix: write at least ${tag.minWords} words in the <${tag.name}> tag`,
                    pack: spec.packId,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  const hasFailures = diagnostics.length > 0;

  return {
    data: {
      checkedFiles: summary.authoredFiles,
      failures: failures.length,
      summary,
      diagnostics,
    },
    exitCode: hasFailures ? 1 : 0,
    summary: hasFailures
      ? undefined
      : `[compass.validate] OK (${summary.authoredFiles} authored files checked)`,
  };
}
