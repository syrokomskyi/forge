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
  <item>Add rfc.pipeline.status command for agents and humans to inspect where an RFC stands in the create → audit → enhance → plan → implement pipeline.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";

import { listRfcFiles, readAndParseRfc } from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type { RfcStatus } from "../types.ts";
import { RFC_DIR } from "../types.ts";

export type PipelineStage = "audit" | "enhance" | "plan" | "implement";

export interface RfcPipelineStageInfo {
  stage: PipelineStage;
  done: boolean;
  /** File or marker that confirms completion, when applicable. */
  evidence?: string;
}

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

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["implemented", "rejected", "superseded"]);

async function findAuditFile(workspaceRoot: string, rfcId: string): Promise<string | undefined> {
  const auditsDir = path.join(workspaceRoot, "docs/audits");
  try {
    const entries = await fs.readdir(auditsDir);
    const prefix = `audit-${rfcId.toLowerCase()}`;
    const match = entries.find((e) => e.toLowerCase().startsWith(prefix) && e.endsWith(".md"));
    return match ? path.join("docs/audits", match) : undefined;
  } catch {
    return undefined;
  }
}

async function findPlanFile(workspaceRoot: string, rfcId: string): Promise<string | undefined> {
  const plansDir = path.join(workspaceRoot, "docs/plans");
  try {
    const entries = await fs.readdir(plansDir);
    const prefix = `plan-${rfcId.toLowerCase()}`;
    const match = entries.find((e) => e.toLowerCase().startsWith(prefix) && e.endsWith(".md"));
    return match ? path.join("docs/plans", match) : undefined;
  } catch {
    return undefined;
  }
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

    const stages: RfcPipelineStageInfo[] = [
      {
        stage: "audit",
        done: !!auditFile,
        evidence: auditFile,
      },
      {
        stage: "enhance",
        done: !!enhancedAt,
        evidence: enhancedAt ? `enhancedAt: ${enhancedAt}` : undefined,
      },
      {
        stage: "plan",
        done: !!planFile,
        evidence: planFile,
      },
      {
        stage: "implement",
        done: status === "implemented" || !!implementedAt,
        evidence: implementedAt ? `implementedAt: ${implementedAt}` : undefined,
      },
    ];

    let nextStep: PipelineStage | null = null;
    if (!isTerminal) {
      for (const s of stages) {
        if (!s.done) {
          nextStep = s.stage;
          break;
        }
      }
    }

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
