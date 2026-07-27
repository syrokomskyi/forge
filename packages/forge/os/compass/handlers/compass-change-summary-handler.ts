/*
<MODULE_CONTRACT>
<purpose>CHANGE_SUMMARY classification, validation, and deterministic tidy logic
per RFC-0349. Moved from @warpgogol/site-kernel-checks to @webgogol/forge for full
autonomous mode (RFC-0556). Provides compass.changesummary.validate and compass.summary.trim.</purpose>
<non-goals>
  <item>Do not audit truthfulness of CHANGE_SUMMARY items against code — that is RFC-0352.</item>
  <item>Do not delete protected (RFC/code-referencing) items under any circumstance.</item>
  <item>Do not use an LLM — classification and tidy are purely deterministic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0349: initial implementation of classifyChangeSummaryItem, compass.changesummary.validate, and compass.changesummary.tidy.</item>
  <item>RFC-0538: renamed compass.changesummary.tidy to compass.summary.trim, raised cap from 3 unprotected to 30 total items, aligned validate cap to 30 total.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-checks to @webgogol/forge for autonomous mode.</item>
</CHANGE_SUMMARY>
*/

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createCompassInventoryEntries } from "./compass-inventory.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const PROTECTED_RE = /\b([A-Z][A-Z0-9]*-)+\d+\b/;
const BOILERPLATE_RE =
  /^(Wave\s+\d|Backfill\b|Annotate Compass|Annotation revision|Initial creation|Compass scaffolding|Created as part of|Enhance .* with Compass)/i;

export type ChangeSummaryItemClass = "protected" | "boilerplate" | "unprotected";

export function classifyChangeSummaryItem(text: string): ChangeSummaryItemClass {
  if (PROTECTED_RE.test(text)) return "protected";
  if (BOILERPLATE_RE.test(text.trim())) return "boilerplate";
  return "unprotected";
}

function extractChangeSummaryBlock(source: string): string | null {
  const match = source.match(/<CHANGE_SUMMARY>[\s\S]*?<\/CHANGE_SUMMARY>/);
  return match?.[0] ?? null;
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

function rebuildChangeSummaryBlock(items: string[]): string {
  const lines = ["<CHANGE_SUMMARY>"];
  for (const item of items) {
    lines.push(`  <item>${item}</item>`);
  }
  lines.push("</CHANGE_SUMMARY>");
  return lines.join("\n");
}

function replaceChangeSummaryBlock(source: string, newBlock: string): string {
  return source.replace(/<CHANGE_SUMMARY>[\s\S]*?<\/CHANGE_SUMMARY>/, newBlock);
}

const MAX_TOTAL_ITEMS = 30;

export async function runCompassChangeSummaryValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    command: string;
    status: "pass" | "fail";
    diagnostics: Diagnostic[];
    checkedFiles: number;
  }>
> {
  const scanRoot = resolveCompassScanRoot(input, context);
  const entries = await createCompassInventoryEntries(context.workspaceRoot, input, scanRoot);

  const diagnostics: Diagnostic[] = [];
  let checkedFiles = 0;

  for (const entry of entries) {
    if (entry.authoringStatus !== "authored" || entry.requiredScaffolding === "none") {
      continue;
    }

    checkedFiles++;

    if (!entry.hasChangeSummary) {
      continue;
    }

    const absPath = resolve(context.workspaceRoot, entry.path);
    const source = await readFile(absPath, "utf8");
    const block = extractChangeSummaryBlock(source);
    if (!block) continue;

    const items = extractItems(block);
    let hasBoilerplate = false;
    let totalItems = 0;

    for (const item of items) {
      const cls = classifyChangeSummaryItem(item);
      if (cls === "boilerplate") {
        hasBoilerplate = true;
      }
      totalItems++;
    }

    if (hasBoilerplate) {
      diagnostics.push({
        ruleId: "COMPASS-CS-01",
        severity: "error",
        file: entry.path,
        message: "CHANGE_SUMMARY contains a boilerplate item",
        fixHint: "fix: run compass.summary.trim",
      });
    }

    if (totalItems > MAX_TOTAL_ITEMS) {
      diagnostics.push({
        ruleId: "COMPASS-CS-02",
        severity: "error",
        file: entry.path,
        message: `CHANGE_SUMMARY has ${totalItems} total items (cap is ${MAX_TOTAL_ITEMS})`,
        fixHint: `fix: run compass.summary.trim (cap is ${MAX_TOTAL_ITEMS} total items)`,
      });
    }
  }

  const failed = diagnostics.length > 0;

  for (const d of diagnostics) {
    context.logger.error(`[compass.changesummary.validate] ${d.ruleId}: ${d.file}: ${d.message}`);
  }

  return {
    data: {
      command: "compass.changesummary.validate",
      status: failed ? "fail" : "pass",
      diagnostics,
      checkedFiles,
    },
    exitCode: failed ? 1 : 0,
    summary: failed
      ? undefined
      : `[compass.changesummary.validate] OK (${checkedFiles} authored files checked)`,
  };
}

const TRIM_FALLBACK_ITEM = "Tidied by compass.summary.trim; see git history for prior entries.";

export async function runCompassSummaryTrim(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<
  ForgeCommandResult<{
    command: string;
    status: "ok";
    files: Array<{ path: string; removed: string[]; kept: number }>;
  }>
> {
  if (context.dryRun) {
    context.logger.info(`[compass.summary.trim] dry-run active — will not apply changes`);
  }

  const scanRoot = resolveCompassScanRoot(input, context);
  const entries = await createCompassInventoryEntries(context.workspaceRoot, input, scanRoot);

  const results: Array<{ path: string; removed: string[]; kept: number }> = [];

  for (const entry of entries) {
    if (entry.authoringStatus !== "authored" || entry.requiredScaffolding === "none") {
      continue;
    }

    if (!entry.hasChangeSummary) {
      continue;
    }

    const absPath = resolve(context.workspaceRoot, entry.path);
    const source = await readFile(absPath, "utf8");
    const block = extractChangeSummaryBlock(source);
    if (!block) continue;

    const items = extractItems(block);
    const keptItems: string[] = [];
    const removedItems: string[] = [];

    const unprotectedItems: Array<{ index: number; text: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const text = items[i]!;
      const cls = classifyChangeSummaryItem(text);

      if (cls === "protected") {
        keptItems.push(text);
      } else if (cls === "boilerplate") {
        removedItems.push(text);
      } else {
        unprotectedItems.push({ index: i, text });
      }
    }

    const protectedCount = keptItems.length;
    const maxUnprotectedToKeep = Math.max(0, MAX_TOTAL_ITEMS - protectedCount);
    const unprotectedToKeep = unprotectedItems.slice(-maxUnprotectedToKeep);
    const unprotectedToRemove = unprotectedItems.slice(0, -maxUnprotectedToKeep);

    for (const item of unprotectedToRemove) {
      removedItems.push(item.text);
    }

    const keepSet = new Set<string>();
    for (const item of unprotectedToKeep) {
      keepSet.add(item.text);
    }

    const finalItems: string[] = [];
    const protectedTexts = new Set(keptItems);
    const unprotectedTexts = new Set(unprotectedToKeep.map((u) => u.text));

    for (const originalItem of items) {
      if (protectedTexts.has(originalItem) || unprotectedTexts.has(originalItem)) {
        finalItems.push(originalItem);
      }
    }

    if (finalItems.length === 0) {
      finalItems.push(TRIM_FALLBACK_ITEM);
    }

    const newBlock = rebuildChangeSummaryBlock(finalItems);
    const transformed = replaceChangeSummaryBlock(source, newBlock);

    if (transformed === source) {
      continue;
    }

    if (!context.dryRun) {
      await writeFileIfChanged(absPath, transformed);
    }

    context.logger.info(
      `[compass.summary.trim] trimmed: ${entry.path} (removed ${removedItems.length}, kept ${finalItems.length})`,
    );

    results.push({
      path: entry.path,
      removed: removedItems,
      kept: finalItems.length,
    });
  }

  return {
    data: {
      command: "compass.summary.trim",
      status: "ok",
      files: results,
    },
    exitCode: 0,
    summary: `[compass.summary.trim] files=${results.length}, removed=${results.reduce((sum, r) => sum + r.removed.length, 0)}`,
  };
}
