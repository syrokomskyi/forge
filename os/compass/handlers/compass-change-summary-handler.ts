/*
<MODULE_CONTRACT>
<purpose>CHANGE_SUMMARY v2 repair logic per RFC-1095. Moved from
@warpgogol/site-kernel-checks to @warpgogol/forge for full autonomous mode
(RFC-0556). Provides compass.summary.trim --mode repair.</purpose>
<non-goals>
  <item>Do not audit truthfulness of CHANGE_SUMMARY items against code — that is RFC-0352.</item>
  <item>Do not use an LLM — repair is purely deterministic.</item>
  <item>Do not classify items — under the v2 contract every item carries a governance ID; ID-less items are removed, not classified.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0538: renamed compass.changesummary.tidy to compass.summary.trim, raised cap from 3 unprotected to 30 total items, aligned validate cap to 30 total.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-checks to @warpgogol/forge for autonomous mode.</item>
  <item>RFC-1094: --mode flag; mode-aware COMPASS-CS-05/06/07 diagnostics via shared evaluateV2Rules; PROTECTED_RE now aliases GOVERNANCE_ID_RE.</item>
  <item>RFC-1095: rewrote trim as v2 repair (collapse >5 described items into history, remove ID-less items, normalize history); removed compass.changesummary.validate and the classify machinery (classifyChangeSummaryItem, PROTECTED_RE, BOILERPLATE_RE).</item>
  <item>RFC-1095: compass.summary.record, trim repair rewrite, commit integration</item>
  <history>RFC-0349</history>
</CHANGE_SUMMARY>
*/

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createCompassInventoryEntries } from "./compass-inventory.ts";
import { resolveCompassPolicy } from "../policy.ts";
import { resolveCompassScanRoot } from "./resolve-scan-root.ts";
import { writeFileIfChanged } from "../../../src/utils/fs-idempotent.ts";
import {
  buildChangeSummaryBlock,
  CHANGE_SUMMARY_WINDOW,
  mergeHistoryIds,
  parseChangeSummary,
} from "./summary-record.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const CHANGE_SUMMARY_BLOCK_RE = /<CHANGE_SUMMARY>[\s\S]*?<\/CHANGE_SUMMARY>/;

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
  const mode = input.flags["mode"];
  if (mode !== undefined && mode !== "repair") {
    context.logger.error(
      `[compass.summary.trim] invalid --mode value: ${String(mode)} (expected "repair")`,
    );
    return { exitCode: 1, summary: "invalid --mode value" };
  }

  if (context.dryRun) {
    context.logger.info(`[compass.summary.trim] dry-run active — will not apply changes`);
  }

  const scanRoot = resolveCompassScanRoot(input, context);
  const policy = resolveCompassPolicy(context.workspaceRoot, context.forgeRoot);
  const entries = await createCompassInventoryEntries(
    context.workspaceRoot,
    input,
    scanRoot,
    policy,
    context.site?.directory,
  );

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
    const blockMatch = source.match(CHANGE_SUMMARY_BLOCK_RE);
    if (!blockMatch) continue;

    const { items, historyIds } = parseChangeSummary(blockMatch[0]);
    const removedItems: string[] = [];

    // v2 repair: drop ID-less items, collapse described items past the window.
    const idItems: string[] = [];
    for (const item of items) {
      if (policy.idPatternPrefix.test(item)) {
        idItems.push(item);
      } else {
        removedItems.push(item);
      }
    }

    const collapsedIds: string[] = [];
    while (idItems.length > CHANGE_SUMMARY_WINDOW) {
      const oldest = idItems.shift()!;
      const idMatch = oldest.match(policy.idPatternPrefix);
      if (idMatch) collapsedIds.push(idMatch[0]);
      removedItems.push(oldest);
    }

    const nextHistory = mergeHistoryIds(historyIds, collapsedIds, policy);
    const historyChanged =
      nextHistory.length !== historyIds.length || nextHistory.some((id, i) => id !== historyIds[i]);

    if (removedItems.length === 0 && !historyChanged) {
      continue;
    }

    const newBlock = buildChangeSummaryBlock(idItems, nextHistory, entry.path);
    const transformed = source.replace(CHANGE_SUMMARY_BLOCK_RE, newBlock);

    if (transformed === source) {
      continue;
    }

    if (!context.dryRun) {
      await writeFileIfChanged(absPath, transformed);
    }

    context.logger.info(
      `[compass.summary.trim] repaired: ${entry.path} (removed ${removedItems.length}, kept ${idItems.length})`,
    );

    results.push({
      path: entry.path,
      removed: removedItems,
      kept: idItems.length,
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
    nextSteps: [
      {
        action: `Commit the repaired headers: pnpm exec forge run ecosystem.commit`,
        kind: "optional",
      },
    ],
  };
}
