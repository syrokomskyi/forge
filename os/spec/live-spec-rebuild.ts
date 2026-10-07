/*
<MODULE_CONTRACT>
<purpose>spec.live.rebuild handler — regenerates a living spec by deterministic
replay of its deduplicated history[] (RFC-1230). The repair path for duplicated
namespaced sections and duplicate history entries produced before spec.live.merge
became idempotent. Replaying each unique RFC's current ## Design in first-occurrence
order yields the canonical spec; hand-applied edits are dropped by design.</purpose>
<non-goals>
  <item>Do not merge new RFCs — that is spec.live.merge.</item>
  <item>Do not validate — spec.live.validate reports what rebuild must repair.</item>
  <item>Do not delete spec files — empty-history or missing specs are skipped, never removed.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1230: initial spec.live.rebuild handler — dedupe history, single RFC scan, replay via shared section mechanics, unchanged-detection modulo updatedAt.</item>
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
  <item>RFC-1231: step 1 — rename supportsAllSites to acceptsAllFlag

Mechanical sweep: the field only ever gated --all argv acceptance; fan-out
follows the parsed selector. Guard renamed assertAllSitesAllowed ->
assertAllFlagAccepted, message updated. 417 declaration sites + type
surfaces (KernelCommandMetadata, ForgeCommandMetadata) in one atomic pass.</item>
</CHANGE_SUMMARY>
*/

import { ambientIo as fs } from "../../src/utils/io.ts";
import { existsSync } from "../../src/utils/sync-fs.ts";
import path from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import { writeFileIfChanged, buildGeneratedHeader } from "../../src/utils/index.ts";
import { listRfcFiles, readAndParseRfc, rfcFileMatchesId } from "../rfc/frontmatter-io.ts";
import { RFC_DIR } from "../rfc/types.ts";
import type {
  DeltaOperation,
  LivingSpec,
  LivingSpecHistoryEntry,
  SpecLiveRebuildResult,
} from "./live-spec-types.ts";
import {
  LIVE_SPECS_DIR,
  extractDesignSection,
  parseHeadings,
  parseLivingSpec,
  serializeLivingSpec,
  applyDeltasToSpecBody,
  namespaceHeadings,
  seedSpecPrefix,
} from "./live-spec-shared.ts";

interface RebuildSummary {
  command: "spec.live.rebuild";
  domains: SpecLiveRebuildResult[];
  dryRun: boolean;
}

async function rebuildOneSpec(
  specFilePath: string,
  domain: string,
  rfcFiles: readonly string[],
  rfcDirPath: string,
  today: string,
  dryRun: boolean,
  context: ForgeRuntimeContext,
): Promise<{ result: SpecLiveRebuildResult; exitCode: number }> {
  const { logger } = context;

  const base: SpecLiveRebuildResult = {
    command: "spec.live.rebuild",
    domain,
    operation: "skipped",
    uniqueRfcs: 0,
    droppedHistoryEntries: 0,
    droppedSections: 0,
    unreadableRfcs: [],
    dryRun,
  };

  const content = await fs.readFile(specFilePath).catch(() => null);
  if (content === null) {
    logger.warn(`spec.live.rebuild: ${domain} unreadable at ${specFilePath} — skipping`);
    return { result: base, exitCode: 1 };
  }
  const spec = parseLivingSpec(content);
  if (!spec) {
    logger.warn(`spec.live.rebuild: ${domain} has no valid frontmatter — skipping`);
    return { result: base, exitCode: 1 };
  }
  if (spec.history.length === 0) {
    return { result: base, exitCode: 0 };
  }

  const uniqueIds: string[] = [];
  const normalizedHistory: LivingSpecHistoryEntry[] = [];
  for (const entry of spec.history) {
    if (!entry?.rfc || uniqueIds.includes(entry.rfc)) continue;
    uniqueIds.push(entry.rfc);
    normalizedHistory.push(entry);
  }

  // Count only namespaced duplicates — the metric is "duplicate (RFC-XXXX)
  // sections removed"; non-namespaced heading repeats are out of contract.
  const existingHeadings = parseHeadings(spec.body);
  const seenTexts = new Set<string>();
  let droppedSections = 0;
  for (const h of existingHeadings) {
    if (!/\(RFC-\d{4}\)$/.test(h.text)) continue;
    if (seenTexts.has(h.text)) droppedSections++;
    else seenTexts.add(h.text);
  }

  const header = buildGeneratedHeader({
    filePath: specFilePath,
    ownerCommand: "spec.live.merge",
    commandPrefix: "pnpm exec werkstatt run",
  });
  // trimEnd so applyDeltas' own "\n\n" separator reproduces the creation path's
  // `seed + designSection` layout exactly — otherwise rebuild inserts an extra
  // blank line after "## Overview" and unchanged-detection never fires.
  let body = seedSpecPrefix(domain, header).trimEnd();
  const unreadableRfcs: string[] = [];

  for (const rfcId of uniqueIds) {
    const file = rfcFiles.find((f) => rfcFileMatchesId(f, rfcId));
    const parsedResult = file
      ? await readAndParseRfc(rfcDirPath, file)
      : undefined;
    const fm =
      parsedResult && "parsed" in parsedResult ? parsedResult.parsed.frontmatter : undefined;
    const status = fm ? String(fm["status"] ?? "").trim() : "";
    const design = parsedResult && "parsed" in parsedResult
      ? extractDesignSection(parsedResult.parsed.body)
      : "";
    if (!fm || status !== "implemented" || !design) {
      unreadableRfcs.push(rfcId);
      logger.warn(
        `spec.live.rebuild: ${rfcId} unreadable, not implemented, or lacks ## Design — skipping`,
      );
      continue;
    }
    const namespaced = namespaceHeadings(design, rfcId);
    const headings = parseHeadings(namespaced);
    const ops: DeltaOperation[] = headings.map((h) => ({
      type: "added",
      heading: h.text,
      rfc: rfcId,
    }));
    body = applyDeltasToSpecBody(body, headings, ops);
  }

  const replayed = uniqueIds.length - unreadableRfcs.length;
  if (replayed === 0) {
    return {
      result: { ...base, operation: "skipped", uniqueRfcs: uniqueIds.length, unreadableRfcs },
      exitCode: 2,
    };
  }

  const regenerated: LivingSpec = {
    ...spec,
    lastMergedRfc: uniqueIds[uniqueIds.length - 1]!,
    history: normalizedHistory,
    body: body.trim(),
  };

  // Compare modulo updatedAt — a clean spec rebuilt on another day must still
  // report unchanged, otherwise every rebuild produces a one-line date diff.
  const candidateSameDate = serializeLivingSpec({ ...regenerated, updatedAt: spec.updatedAt });
  if (candidateSameDate === content) {
    return {
      result: {
        ...base,
        operation: "unchanged",
        uniqueRfcs: uniqueIds.length,
        droppedHistoryEntries: spec.history.length - normalizedHistory.length,
        droppedSections,
        unreadableRfcs,
      },
      exitCode: 0,
    };
  }

  const finalSpec = serializeLivingSpec({ ...regenerated, updatedAt: today });
  if (!dryRun) {
    await writeFileIfChanged(specFilePath, finalSpec);
  }

  return {
    result: {
      ...base,
      operation: "rebuilt",
      uniqueRfcs: uniqueIds.length,
      droppedHistoryEntries: spec.history.length - normalizedHistory.length,
      droppedSections,
      unreadableRfcs,
    },
    exitCode: 0,
  };
}

export async function runSpecLiveRebuild(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RebuildSummary | SpecLiveRebuildResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const domain = String(input.flags["domain"] ?? "");
  const dryRun = context.dryRun || input.flags["dry-run"] === true;

  // The kernel consumes `--all` as its own site-selector before argv reaches
  // the command (acceptsAllFlag: true lets it through). Under `werkstatt run`
  // the flag never lands in input.flags — so "no --domain" IS the kernel-level
  // --all signal. The explicit flag still works via the standalone forge CLI.
  const explicitAll = input.flags["all"] === true;
  if (domain && explicitAll) {
    return {
      data: {
        command: "spec.live.rebuild",
        domains: [],
        dryRun,
      },
      exitCode: 1,
      summary: "spec.live.rebuild: --domain and --all are mutually exclusive",
    };
  }
  const all = explicitAll || !domain;

  const liveSpecsDir = path.join(workspaceRoot, LIVE_SPECS_DIR);
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);
  const today = new Date().toISOString().slice(0, 10);

  const specPaths: Array<{ domain: string; filePath: string }> = [];
  if (all) {
    if (existsSync(liveSpecsDir)) {
      const files = (await fs.readdir(liveSpecsDir)).map((e) => e.name);
      for (const f of files.filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
        specPaths.push({ domain: f.slice(0, -3), filePath: path.join(liveSpecsDir, f) });
      }
    }
  } else {
    const filePath = path.join(liveSpecsDir, `${domain}.md`);
    if (!existsSync(filePath)) {
      return {
        data: {
          command: "spec.live.rebuild",
          domains: [],
          dryRun,
        },
        exitCode: 1,
        summary: `spec.live.rebuild: living spec not found for domain "${domain}" (${LIVE_SPECS_DIR}/${domain}.md)`,
      };
    }
    specPaths.push({ domain, filePath });
  }

  if (specPaths.length === 0) {
    return {
      data: { command: "spec.live.rebuild", domains: [], dryRun },
      exitCode: 0,
      summary: "spec.live.rebuild: no living specs found",
    };
  }

  // Single recursive RFC scan reused for every spec — a corrupted spec can carry
  // ~170 history entries, and a per-id listRfcFiles rescan is O(n²).
  const rfcFiles = await listRfcFiles(rfcDirPath);

  const results: SpecLiveRebuildResult[] = [];
  let worstExit = 0;
  for (const { domain: d, filePath } of specPaths) {
    const { result, exitCode } = await rebuildOneSpec(
      filePath, d, rfcFiles, rfcDirPath, today, dryRun, context,
    );
    results.push(result);
    if (exitCode > worstExit) worstExit = exitCode;
    if (outputFormat === "pretty") {
      const suffix = dryRun ? " [dry-run]" : "";
      if (result.operation === "rebuilt") {
        logger.success(
          `spec.live.rebuild: ${d} rebuilt — ${result.uniqueRfcs} unique RFC(s), dropped ${result.droppedHistoryEntries} history entr(ies), ${result.droppedSections} duplicate section(s)${suffix}`,
        );
      } else {
        logger.info(`spec.live.rebuild: ${d} — ${result.operation}${suffix}`);
      }
    }
  }

  if (!all) {
    return {
      data: results[0]!,
      exitCode: worstExit,
      summary: `spec.live.rebuild: ${domain} — ${results[0]!.operation}`,
    };
  }

  return {
    data: { command: "spec.live.rebuild", domains: results, dryRun },
    exitCode: worstExit,
    summary: `spec.live.rebuild: ${results.length} spec(s) processed${dryRun ? " [dry-run]" : ""}`,
  };
}
