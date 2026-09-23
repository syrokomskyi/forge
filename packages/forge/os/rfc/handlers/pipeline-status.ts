/*
<MODULE_CONTRACT>
<purpose>Reports the pipeline status of RFCs — which steps (audit, enhance, plan, implement) are complete or missing.</purpose>
<non-goals>
  <item>Does not validate RFC content — use rfc.validate for that.</item>
  <item>Does not mutate any files.</item>
  <item>Does not gate skill execution — skills keep their own prerequisite checks.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1140: refactored onto the shared resolver in src/pipeline-status.ts —
  artifact finders, TERMINAL_STATUSES, and stage computation now imported from
  the portable layer so queue.validate and the orchestrator share one derivation.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
  <item>RFC-1140: steps 1-4 — shared resolver, queue module, registration

Extract pipeline-status derivation into packages/forge/src/pipeline-status.ts, refactor rfc.pipeline.status onto it, add os/queue module with queue.validate command, register in WORKSHOP_MODULE_MAP.forge + bin/cli.ts + package.json exports.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import { listRfcFiles, readAndParseRfc } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  TERMINAL_STATUSES,
  computeRfcPipelineStages,
  findAuditFile,
  findPlanFile,
  nextPipelineStep,
} from "../../../src/pipeline-status.ts";
import type { PipelineStage, RfcPipelineStageInfo } from "../../../src/pipeline-status.ts";
import type { RfcStatus } from "../types.ts";
import { RFC_DIR } from "../types.ts";

export type { PipelineStage, RfcPipelineStageInfo };

export interface RfcPipelineEntry {
  id: string;
  title: string;
  status: RfcStatus;
  file: string;
  stages: RfcPipelineStageInfo[];
  /** The immediate next missing step, or null if all are done. */
  nextStep: PipelineStage | null;
}

export interface RfcPipelineStatusResult {
  command: "rfc.pipeline.status";
  status: "ok";
  count: number;
  entries: RfcPipelineEntry[];
}

export async function runRfcPipelineStatus(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcPipelineStatusResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const targetId = input.flags["id"] as string | undefined;

  let files = await listRfcFiles(rfcDirPath);
  if (targetId) {
    const lower = targetId.toLowerCase();
    files = files.filter((f) => path.basename(f).toLowerCase().startsWith(lower));
    if (files.length === 0) {
      throw new Error(`No RFC file found for id ${targetId} in ${RFC_DIR}/`);
    }
  }

  const entries: RfcPipelineEntry[] = [];

  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    if (!result || "error" in result) continue;
    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "");
    const title = String(fm["title"] ?? "");
    const status = String(fm["status"] ?? "") as RfcStatus;
    const enhancedAt = fm["enhancedAt"] ? String(fm["enhancedAt"]) : undefined;
    const implementedAt = fm["implementedAt"] ? String(fm["implementedAt"]) : undefined;

    const isTerminal = TERMINAL_STATUSES.has(status);

    const auditFile = await findAuditFile(workspaceRoot, id);
    const planFile = await findPlanFile(workspaceRoot, id);

    const stages: RfcPipelineStageInfo[] = computeRfcPipelineStages({
      status,
      enhancedAt,
      implementedAt,
      auditFile,
      planFile,
    });

    const nextStep: PipelineStage | null = isTerminal ? null : nextPipelineStep(status, stages);

    entries.push({
      id,
      title,
      status,
      file: path.join(RFC_DIR, fileName),
      stages,
      nextStep,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  if (outputFormat === "pretty") {
    logger.section(`RFC pipeline status (${entries.length} RFC(s))`);
    for (const entry of entries) {
      const stageStr = entry.stages.map((s) => `${s.stage}:${s.done ? "✓" : "—"}`).join("  ");
      const next = entry.nextStep ? ` → next: ${entry.nextStep}` : "";
      const terminal = TERMINAL_STATUSES.has(entry.status) ? " (terminal)" : "";
      logger.info(`${entry.id} [${entry.status}${terminal}]  ${stageStr}${next}`);
    }
  }

  return {
    data: { command: "rfc.pipeline.status", status: "ok", count: entries.length, entries },
    summary: `Pipeline status for ${entries.length} RFC(s)`,
  };
}
