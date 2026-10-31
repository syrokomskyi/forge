/*
<MODULE_CONTRACT>
<purpose>
RFC-1472: trajectory.index [--session <id>] [--since <date>] [--rebuild] —
extracts procedure units from GREEN-VERIFIED sessions (verdict indicates
success — admission at extraction, not recall). Each unit binds a situation
key {taskKind, touchedPathClasses, recentActions} to a continuation
{commandSequence, decisions, outcomeHash} + producer meta. Units land in
docs/.index/trajectory/units.yaml (gitignored projection). Failed/abandoned
sessions produce nothing. --export/--import for shard portability.
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1472: trajectory.index green-verified procedure-unit extraction + shard export/import</item>
  <item>RFC-1472: trajectory.index + trajectory.recall + trajectory.outcome.record — procedural-memory retrieval with green-verdict admission</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { createHash } from "node:crypto";
import { stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { listSessionFiles, readAndParseSession } from "../../session/frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface ProcedureUnit {
  id: string;
  kind: "trajectory";
  situation: { taskKind: string; touchedPathClasses: string[]; recentActions: string[] };
  continuation: { commandSequence: string[]; decisions: string[]; outcomeHash: string };
  producer: { workshopId: string; sessionId: string; completedAt: string; verdictRef: string };
  source: string;
  tokens: number;
  text: string;
  usedBy: { recalled: number; helped: number; hurt: number };
  utilityScore: number;
}

export interface TrajectoryIndexData {
  command: "trajectory.index";
  status: "ok";
  units: number;
  admitted: number;
  rejected: number;
  index: string;
}

const GREEN_RE = /green|pass|success|verified|ok/i;

function pathClass(p: string): string {
  const parts = p.split("/");
  if (parts[0] === "docs" && parts[1] === "rfcs") return "rfcs";
  if (parts[0] === "docs" && parts[1] === "sessions") return "sessions";
  if (parts[0] === "docs" && parts[1]) return `docs/${parts[1]}`;
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts[0] === ".agents" && parts[1] === "skills") return "skills";
  if (parts[0] === "missions") return "missions";
  return parts[0] ?? "?";
}

export async function runTrajectoryIndex(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<TrajectoryIndexData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const sessionFilter = input.flags["session"] as string | undefined;
  const since = input.flags["since"] as string | undefined;
  const exportPath = input.flags["export"] as string | undefined;

  const sessionsDir = path.join(root, "docs", "sessions");
  const files = (await listSessionFiles(sessionsDir).catch(() => []))
    .filter((f) => !sessionFilter || f.includes(sessionFilter))
    .filter((f) => !since || f >= since);

  const units: ProcedureUnit[] = [];
  let admitted = 0, rejected = 0;
  for (const rel of files) {
    const result = await readAndParseSession(sessionsDir, rel).catch(() => null);
    if (!result) continue;
    const fm = result.parsed.frontmatter;
    const verdict = typeof fm.verdict === "string" ? fm.verdict : "";
    // Admission at extraction — green-verified (explicit verdict) OR the
    // declared success signal: commits[] non-empty AND no open blockers.
    const commits = Array.isArray(fm.commits) ? fm.commits : [];
    const blockers = Array.isArray(fm.remainingIssues) ? fm.remainingIssues : Array.isArray(fm.blockers) ? fm.blockers : [];
    const green = verdict ? GREEN_RE.test(verdict) : commits.length > 0 && blockers.length === 0;
    if (!green) { rejected++; continue; }
    admitted++;
    const commands = Array.isArray(fm.commands) ? fm.commands as string[] : [];
    const decisions = Array.isArray(fm.decisions) ? (fm.decisions as string[]).filter((d): d is string => typeof d === "string") : [];
    const paths = Array.isArray(fm.filesChanged) ? fm.filesChanged as string[] : [];
    const taskKind = String(fm.taskKind ?? fm.purpose ?? "general");
    const sid = String(fm.id ?? path.basename(rel, ".md"));
    const seq = commands.slice(0, 8);
    const outcomeHash = createHash("sha1").update(JSON.stringify({ commands: seq, verdict })).digest("hex").slice(0, 12);
    const text = `${taskKind}: ran ${seq.slice(0, 4).join(" → ")}${seq.length > 4 ? "…" : ""} → ${verdict}`;
    units.push({
      id: `trajectory:${sid}`,
      kind: "trajectory",
      situation: {
        taskKind,
        touchedPathClasses: [...new Set(paths.map(pathClass))].slice(0, 6),
        recentActions: seq.slice(-3),
      },
      continuation: { commandSequence: seq, decisions: decisions.slice(0, 5), outcomeHash },
      producer: { workshopId: "werkstatt", sessionId: sid, completedAt: String(fm.date ?? ""), verdictRef: verdict || `commits:${commits.length}` },
      source: `docs/sessions/${rel}`,
      tokens: Math.ceil(text.length / 4),
      text,
      usedBy: { recalled: 0, helped: 0, hurt: 0 },
      utilityScore: 0,
    });
  }

  const indexDir = path.join(root, "docs", ".index", "trajectory");
  await io.mkdir(indexDir).catch(() => {});
  const indexRel = "docs/.index/trajectory/units.yaml";
  await io.writeFile(path.join(root, indexRel), yamlStringify({ schema: "forge/trajectory-index@1", units }) + "\n");

  if (exportPath) {
    const shard = { schema: "forge/trajectory-shard@1", exportedFrom: "werkstatt", units, producerStats: {} };
    await io.writeFile(path.join(root, exportPath), yamlStringify(shard) + "\n");
  }
  return {
    data: { command: "trajectory.index", status: "ok", units: units.length, admitted, rejected, index: indexRel },
    summary: `${units.length} unit(s): ${admitted} green admitted, ${rejected} rejected → ${indexRel}${exportPath ? ` + shard ${exportPath}` : ""}`,
    exitCode: 0,
  };
}
