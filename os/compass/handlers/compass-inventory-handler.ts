/*
<MODULE_CONTRACT>
<purpose>Compass inventory and validation command handlers. Moved from
@warpgogol/site-kernel-checks to @warpgogol/forge for full autonomous mode (RFC-0556).
Provides runCompassInventory (XML report generation) and runCompassValidation
(compliance diagnostics with COMPASS-* rules).</purpose>
<non-goals>
  <item>Do not handle raw file parsing or content analysis.</item>
  <item>Do not manage configuration or orchestration of external services.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0348: v2 two-block contract — XML output updated, compass.validate emits COMPASS-* diagnostics, summary uses standard-required-files.</item>
  <item>RFC-0350: added COMPASS-TODO-01 diagnostic for unfilled Compass TODO sentinels.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-checks to @warpgogol/forge for autonomous mode.</item>
</CHANGE_SUMMARY>
*/

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createCompassInventoryEntries, type CompassInventoryEntry } from "./compass-inventory.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const INVENTORY_OUTPUT_PATH = "docs/compass-inventory.xml";

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
    };
  }

  const xml = renderInventoryXml(entries, summary);
  const outputPath = resolve(context.workspaceRoot, INVENTORY_OUTPUT_PATH);
  await writeFileIfChanged(outputPath, xml);

  return {
    data: { entries: entries.length, outputPath, summary },
    summary: `[compass.inventory] ${context.dryRun ? "previewed" : "wrote"} ${INVENTORY_OUTPUT_PATH}`,
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
