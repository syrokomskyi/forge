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
  <item>RFC-1475: TRAJ-01/02 split (absent vs empty/stale/missing-watermark), {workshopId, sessionClass} trust buckets, recalls.jsonl append-only journal</item>
  <item>RFC-1472: trajectory.recall situation-similarity top-k + journaled invocation</item>
  <item>RFC-1472: trajectory.index + trajectory.recall + trajectory.outcome.record — procedural-memory retrieval with green-verdict admission</item>
  <item>RFC-1472: apply r1 repairs — outcomes replay on rebuild, real schema fields, anchored GREEN_RE, shard import, unique recallIds, archive coverage, trajectory kind</item>
  <item>RFC-1475: apply review round-1 findings — vendored-label replay order, real workshopId, cache bypass, TRAJ-06 diagnostics, ENOENT-only journal reads</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { listSessionFiles, listArchivedSessionFiles } from "../../session/frontmatter-io.ts";
import { appendJsonl, isEnoent, readRecallsJournal } from "./journal-io.ts";
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
  diagnostics?: { ruleId?: string; severity?: string; message?: string }[];
}

function emptyResult(task: string, k: number, ruleId: string, message: string): ForgeCommandResult<RecallData> {
  return {
    data: {
      command: "trajectory.recall",
      status: "ok",
      task,
      k,
      recallId: "",
      units: [],
      diagnostics: [{ ruleId, severity: "error", message }],
    },
    summary: `${ruleId} ${message}`,
    exitCode: 1,
  };
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
  const indexSrc = await io.readFile(path.join(root, "docs", ".index", "trajectory", "units.yaml")).catch((e) => {
    if (isEnoent(e)) return null;
    throw e;
  });
  if (indexSrc === null) {
    return emptyResult(task, k, "TRAJ-01", "index missing — run trajectory.index");
  }
  let index: { sourceWatermark?: string; units?: ProcedureUnit[] } | null;
  try {
    index = yamlParse(indexSrc) as typeof index;
  } catch {
    index = null;
  }
  if (index === null || typeof index !== "object" || !Array.isArray(index.units)) {
    return emptyResult(task, k, "TRAJ-02", "index unparseable or not a unit index — rerun trajectory.index");
  }
  const units = index.units;

  // RFC-1475 F6 — TRAJ-02 covers every present-but-unusable index state:
  // empty units, missing sourceWatermark (pre-upgrade index is stale by
  // construction), or a watermark older than the newest session FILENAME —
  // basenames compare like-for-like across sessions/ and sessions/archive/.
  const sessionsDir = path.join(root, "docs", "sessions");
  const newestSource = [
    ...(await listSessionFiles(sessionsDir).catch(() => [])),
    ...(await listArchivedSessionFiles(sessionsDir).catch(() => [])),
  ].reduce((max, rel) => {
    const name = path.basename(rel);
    return name > max ? name : max;
  }, "");
  const watermark = index?.sourceWatermark;
  if (units.length === 0) {
    return emptyResult(task, k, "TRAJ-02", "index is empty — run trajectory.index after green sessions exist");
  }
  if (!watermark) {
    return emptyResult(task, k, "TRAJ-02", "index predates watermark support — rerun trajectory.index");
  }
  if (newestSource > watermark) {
    return emptyResult(task, k, "TRAJ-02", `index stale — watermark ${watermark} predates ${newestSource}; rerun trajectory.index`);
  }

  // RFC-1475 F10 — per-producer trust: aggregate helped/(helped+hurt) per
  // {workshopId, sessionClass} bucket across the whole unit set; a vendored
  // unit scores under its origin's bucket, never smeared across units.
  const buckets = new Map<string, { helped: number; hurt: number }>();
  for (const u of units) {
    const key = `${u.producer.workshopId}|${u.producer.sessionClass ?? "adhoc"}`;
    const bucket = buckets.get(key) ?? { helped: 0, hurt: 0 };
    bucket.helped += u.usedBy.helped;
    bucket.hurt += u.usedBy.hurt;
    buckets.set(key, bucket);
  }
  const bucketTrust = (u: ProcedureUnit): number => {
    const bucket = buckets.get(`${u.producer.workshopId}|${u.producer.sessionClass ?? "adhoc"}`);
    if (!bucket || bucket.helped + bucket.hurt === 0) return 0.5;
    return bucket.helped / (bucket.helped + bucket.hurt);
  };

  const taskTokens = new Set(task.toLowerCase().split(/[^a-z0-9_.-]+/).filter((t) => t.length > 2));
  const scored = units.map((u) => {
    const reasons: string[] = [];
    let score = 0;
    const sit = `${u.situation.taskKind} ${u.situation.recentActions.join(" ")}`.toLowerCase();
    const hits = [...taskTokens].filter((t) => sit.includes(t) || u.text.toLowerCase().includes(t)).length;
    if (hits > 0) { reasons.push(`lexical:${hits}`); score += hits * 2; }
    const pathOverlap = u.situation.touchedPathClasses.filter((p) => [...pathTerms].some((t) => p.includes(t))).length;
    if (pathOverlap > 0) { reasons.push(`path:${pathOverlap}`); score += pathOverlap * 3; }
    // Sparse buckets score at the neutral 0.5 trust the RFC promises — an
    // unlabeled producer must not rank below a fresh one (labeled or not,
    // the trust term always applies).
    const trust = bucketTrust(u);
    reasons.push(`trust:${trust.toFixed(2)}`);
    score += trust * 2;
    score += u.utilityScore * 0.5;
    const days = u.producer.completedAt ? Math.max(0, (Date.now() - new Date(u.producer.completedAt).getTime()) / 86_400_000) : 365;
    const recency = Math.max(0, 1 - days / 365);
    if (recency > 0.5) { reasons.push(`recent:${days.toFixed(0)}d`); score += recency; }
    if (reasons.length === 0) reasons.push("baseline");
    return { ...u, score: Number(score.toFixed(3)), reasons };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);

  // Journal the recall — append-only recalls.jsonl (RFC-1475 F11); the
  // marginal-utility measurement needs the invocation record.
  const journalRead = await readRecallsJournal(root, io);
  for (const warning of journalRead.warnings) context.logger.warn(warning);
  const journalTruncated = journalRead.truncated;
  if (journalTruncated) {
    context.logger.warn("TRAJ-06 recalls.jsonl carried a truncated tail record — partial record dropped, journal survives");
  }
  const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const recallId = `R-${dayKey}-${String(journalRead.records.length + 1).padStart(2, "0")}-${createHashFallback(task).slice(0, 4)}`;
  await appendJsonl(
    io,
    path.join(root, "docs", ".index", "trajectory", "recalls.jsonl"),
    { id: recallId, task, unitsReturned: scored.map((u) => u.id), at: new Date().toISOString() },
  );

  return {
    data: {
      command: "trajectory.recall",
      status: "ok",
      task,
      k,
      recallId,
      units: scored,
      diagnostics: journalTruncated
        ? [{ ruleId: "TRAJ-06", severity: "warning", message: "recalls.jsonl carried a truncated tail record — partial record dropped, journal survives" }]
        : undefined,
    },
    summary: `${scored.length}/${units.length} unit(s) recalled for "${task.slice(0, 50)}" (recall ${recallId})`,
    exitCode: 0,
  };
}

function createHashFallback(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}
