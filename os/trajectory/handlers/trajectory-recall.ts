/*
<MODULE_CONTRACT>
<purpose>
RFC-1472: trajectory.recall --task "<desc>" [--paths <globs>] [--k 5] — top-k
procedure units by situation similarity (taskKind, path-class overlap,
recency, producer trust). Each unit carries source + usedBy + utilityScore.
The recall invocation is journaled so marginal utility can be measured.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1472: trajectory.recall situation-similarity top-k + journaled invocation</item>
  <item>RFC-1472: trajectory.index + trajectory.recall + trajectory.outcome.record — procedural-memory retrieval with green-verdict admission</item>
  <item>RFC-1472: apply r1 repairs — outcomes replay on rebuild, real schema fields, anchored GREEN_RE, shard import, unique recallIds, archive coverage, trajectory kind</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type { ProcedureUnit } from "./trajectory-index.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface RecallUnit extends ProcedureUnit {
  score: number;
  reasons: string[];
}

export interface RecallData {
  command: "trajectory.recall";
  status: "ok";
  task: string;
  k: number;
  recallId: string;
  units: RecallUnit[];
}

export async function runTrajectoryRecall(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RecallData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const task = String(input.flags["task"] ?? "");
  const k = Math.max(1, Math.min(20, Number(input.flags["k"] ?? 5) || 5));
  const pathTerms = new Set(String(input.flags["paths"] ?? "").toLowerCase().split(/[\s,]+/).filter((t) => t.length > 2));
  if (!task) {
    return { data: { command: "trajectory.recall", status: "ok", task: "", k, recallId: "", units: [] }, summary: "missing --task", exitCode: 1 };
  }
  const indexSrc = await io.readFile(path.join(root, "docs", ".index", "trajectory", "units.yaml")).catch(() => null);
  if (indexSrc === null) {
    return { data: { command: "trajectory.recall", status: "ok", task, k, recallId: "", units: [] }, summary: "TRAJ-01 index missing — run trajectory.index", exitCode: 1 };
  }
  const units = ((yamlParse(indexSrc) as { units?: ProcedureUnit[] } | null)?.units ?? []);

  const taskTokens = new Set(task.toLowerCase().split(/[^a-z0-9_.-]+/).filter((t) => t.length > 2));
  const scored = units.map((u) => {
    const reasons: string[] = [];
    let score = 0;
    const sit = `${u.situation.taskKind} ${u.situation.recentActions.join(" ")}`.toLowerCase();
    const hits = [...taskTokens].filter((t) => sit.includes(t) || u.text.toLowerCase().includes(t)).length;
    if (hits > 0) { reasons.push(`lexical:${hits}`); score += hits * 2; }
    const pathOverlap = u.situation.touchedPathClasses.filter((p) => [...pathTerms].some((t) => p.includes(t))).length;
    if (pathOverlap > 0) { reasons.push(`path:${pathOverlap}`); score += pathOverlap * 3; }
    const trust = u.usedBy.helped + u.usedBy.hurt > 0 ? u.usedBy.helped / (u.usedBy.helped + u.usedBy.hurt) : 0.5;
    if (u.usedBy.helped > 0) { reasons.push(`trust:${trust.toFixed(2)}`); score += trust * 2; }
    score += u.utilityScore * 0.5;
    const days = u.producer.completedAt ? Math.max(0, (Date.now() - new Date(u.producer.completedAt).getTime()) / 86_400_000) : 365;
    const recency = Math.max(0, 1 - days / 365);
    if (recency > 0.5) { reasons.push(`recent:${days.toFixed(0)}d`); score += recency; }
    if (reasons.length === 0) reasons.push("baseline");
    return { ...u, score: Number(score.toFixed(3)), reasons };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);

  // Journal the recall — marginal-utility measurement needs the invocation record.
  const journalRel = "docs/.index/trajectory/recalls.yaml";
  const journalSrc = await io.readFile(path.join(root, journalRel)).catch(() => "");
  const journal = (yamlParse(journalSrc) as { recalls?: unknown[] } | null)?.recalls ?? [];
  const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const recallId = `R-${dayKey}-${String(journal.length + 1).padStart(2, "0")}-${createHashFallback(task).slice(0, 4)}`;
  journal.push({ id: recallId, task, unitsReturned: scored.map((u) => u.id), at: new Date().toISOString() });
  const { stringify } = await import("yaml");
  await io.mkdir(path.join(root, "docs", ".index", "trajectory")).catch(() => {});
  await io.writeFile(path.join(root, journalRel), stringify({ schema: "forge/trajectory-recalls@1", recalls: journal }) + "\n");

  return {
    data: { command: "trajectory.recall", status: "ok", task, k, recallId, units: scored },
    summary: `${scored.length}/${units.length} unit(s) recalled for "${task.slice(0, 50)}" (recall ${recallId})`,
    exitCode: 0,
  };
}

function createHashFallback(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}
