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
  <item>RFC-1475: verdict-artifact binding + TRAJ-04 rebuild drop, sourceWatermark, sessionClass/origin producer fields, bucketed producerStats on shard export, JSONL journal replay</item>
  <item>RFC-1472: trajectory.index green-verified procedure-unit extraction + shard export/import</item>
  <item>RFC-1472: trajectory.index + trajectory.recall + trajectory.outcome.record — procedural-memory retrieval with green-verdict admission</item>
  <item>RFC-1472: apply r1 repairs — outcomes replay on rebuild, real schema fields, anchored GREEN_RE, shard import, unique recallIds, archive coverage, trajectory kind</item>
  <item>RFC-1472: apply r2 repairs — archive-source provenance, outcome-replay + provenance regression tests</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { createHash } from "node:crypto";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { listSessionFiles, listArchivedSessionFiles, readAndParseSession } from "../../session/frontmatter-io.ts";
import { readOutcomesJournal, readRecallsJournal } from "./journal-io.ts";
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
  producer: {
    workshopId: string;
    sessionId: string;
    completedAt: string;
    verdictRef: string;
    /** RFC-1475 F10: binary mission|adhoc — session `types[]` containing "mission" ⇒ mission. */
    sessionClass?: "mission" | "adhoc";
    /** RFC-1475 F10: `local` on extraction, `vendored` on shard-imported units. */
    origin?: "local" | "vendored";
  };
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
  /** RFC-1475 TRAJ-04: units dropped whose verdictRef no longer resolves green. */
  dropped: number;
  /** RFC-1475 F6: newest session source path — recall's staleness comparator. */
  sourceWatermark: string;
  index: string;
  diagnostics?: { ruleId?: string; severity?: string; message?: string }[];
}

const GREEN_RE = /^(green|passed?|successful?|verified|ok|clean)$/i;

/** Extract a mission id from session frontmatter provenance lists. */
function deriveMissionId(fm: Record<string, unknown>): string | null {
  const lists = ["relatedArtifacts", "files", "commands"].flatMap((key) =>
    Array.isArray(fm[key]) ? (fm[key] as unknown[]) : [],
  );
  for (const entry of lists) {
    const match = typeof entry === "string" ? entry.match(/missions\/([A-Za-z0-9_-]+)\//) : null;
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Re-resolve a unit's verdictRef post-admission (TRAJ-04): artifact-path refs
 * re-read the evidence file and re-test green; `verdict:<value>` refs re-test
 * the recorded value; `signal:commits` refs are exempt — self-contained.
 */
async function verdictRefResolvesGreen(
  verdictRef: string,
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<boolean> {
  if (verdictRef === "signal:commits") return true;
  if (verdictRef.startsWith("verdict:")) return GREEN_RE.test(verdictRef.slice("verdict:".length));
  const src = await io.readFile(path.join(root, verdictRef)).catch(() => null);
  if (src === null) return false;
  const verdict = (() => {
    try {
      return (JSON.parse(src) as { verdict?: string }).verdict;
    } catch {
      return undefined;
    }
  })();
  return typeof verdict === "string" && GREEN_RE.test(verdict);
}

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
  const archiveBase = path.join(sessionsDir, "archive");
  const files = [
    ...(await listSessionFiles(sessionsDir).catch(() => [])).map((rel) => ({ rel, base: sessionsDir, prefix: "docs/sessions" })),
    ...(await listArchivedSessionFiles(sessionsDir).catch(() => [])).map((rel) => ({ rel, base: archiveBase, prefix: "docs/sessions/archive" })),
  ]
    .filter((f) => !sessionFilter || f.rel.includes(sessionFilter))
    .filter((f) => !since || f.rel >= since);

  // RFC-1475 F6 — the watermark is the newest session FILENAME (basename);
  // date-embedded names sort chronologically across both dirs. Full-path
  // compare would let `archive/` outrank every live file ("a" > "2") and
  // mask real staleness — filenames are the like-for-like key.
  const sourceWatermark = files.reduce(
    (max, f) => {
      const name = path.basename(f.rel);
      return name > max ? name : max;
    },
    "",
  );

  const units: ProcedureUnit[] = [];
  let admitted = 0, rejected = 0;
  for (const { rel, base, prefix } of files) {
    const result = await readAndParseSession(base, rel).catch(() => null);
    if (!result) continue;
    const fm = result.parsed.frontmatter;
    const verdict = typeof fm.verdict === "string" ? fm.verdict : "";
    const commits = Array.isArray(fm.commits) ? fm.commits : [];
    const blockers = Array.isArray(fm.remainingIssues) ? fm.remainingIssues : Array.isArray(fm.blockers) ? fm.blockers : [];
    const commitsSignal = commits.length > 0 && blockers.length === 0;
    // RFC-1475 F4 — verdictRef binds a resolvable artifact or field:
    // (a) mission evidence validation-report.json exists + green → the path;
    // (b) else the session frontmatter `verdict` → `verdict:<value>`;
    // (c) else commits-signal admission → `signal:commits` (self-contained).
    // A present-but-non-green/unparseable evidence file demotes admission to
    // the commits signal — never bind a red artifact.
    const missionId = deriveMissionId(fm);
    const evidenceRel = missionId ? `missions/${missionId}/evidence/validation-report.json` : null;
    let evidenceVerdict: string | null = null;
    if (evidenceRel) {
      const evidenceSrc = await io.readFile(path.join(root, evidenceRel)).catch(() => null);
      if (evidenceSrc !== null) {
        try {
          const parsed = JSON.parse(evidenceSrc) as { verdict?: unknown };
          evidenceVerdict = typeof parsed.verdict === "string" ? parsed.verdict : "";
        } catch {
          evidenceVerdict = "";
        }
      }
    }
    let green: boolean;
    let verdictRef: string;
    if (evidenceVerdict !== null) {
      // Mission evidence exists — it governs admission.
      green = GREEN_RE.test(evidenceVerdict);
      verdictRef = green ? evidenceRel! : "signal:commits";
      if (!green && commitsSignal) { green = true; }
    } else if (verdict) {
      green = GREEN_RE.test(verdict);
      verdictRef = `verdict:${verdict}`;
    } else {
      green = commitsSignal;
      verdictRef = "signal:commits";
    }
    if (!green) { rejected++; continue; }
    admitted++;
    const commands = Array.isArray(fm.commands) ? fm.commands as string[] : [];
    const decisions = Array.isArray(fm.decisions) ? (fm.decisions as string[]).filter((d): d is string => typeof d === "string") : [];
    const paths = Array.isArray(fm.files) ? fm.files as string[] : [];
    const taskKind = Array.isArray(fm.types) && fm.types.length > 0 ? String(fm.types[0]) : String(fm.taskKind ?? "general");
    const sessionClass = Array.isArray(fm.types) && fm.types.includes("mission") ? ("mission" as const) : ("adhoc" as const);
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
      producer: {
        workshopId: "werkstatt",
        sessionId: sid,
        completedAt: String(fm.date ?? ""),
        verdictRef,
        sessionClass,
        origin: "local",
      },
      source: `${prefix}/${rel}`,
      tokens: Math.ceil(text.length / 4),
      text,
      usedBy: { recalled: 0, helped: 0, hurt: 0 },
      utilityScore: 0,
    });
  }

  // Replay prior outcome labels — utility stats are the compounding asset;
  // a rebuild must not zero them (the JSONL journals are the durable asset).
  const outcomesRead = await readOutcomesJournal(root, io);
  const recallsRead = await readRecallsJournal(root, io);
  for (const warning of [...outcomesRead.warnings, ...recallsRead.warnings]) {
    context.logger.warn(warning);
  }
  if (outcomesRead.truncated || recallsRead.truncated) {
    context.logger.warn("TRAJ-06 trajectory journal carried a truncated tail record — partial record dropped, journal survives");
  }
  const outcomes = outcomesRead.records;
  const recalls = recallsRead.records;
  const unitsById = new Map(units.map((u) => [u.id, u]));
  for (const r of recalls) {
    for (const uid of r.unitsReturned ?? []) {
      const u = unitsById.get(uid);
      if (u) u.usedBy.recalled++;
    }
  }
  const recallUnits = new Map(recalls.map((r) => [r.id, r.unitsReturned ?? []]));
  for (const o of outcomes) {
    for (const uid of recallUnits.get(o.recallId ?? "") ?? []) {
      const u = unitsById.get(uid);
      if (!u) continue;
      if (o.helped) u.usedBy.helped++;
      if (o.hurt) u.usedBy.hurt++;
      u.utilityScore = u.usedBy.helped - u.usedBy.hurt;
    }
  }

  // F3 — merge a vendored shard (origin: vendored, trust: review per RFC §4).
  const importPath = input.flags["import"] as string | undefined;
  if (importPath) {
    const shardSrc = await io.readFile(path.join(root, importPath)).catch(() => null);
    const shard = shardSrc ? (yamlParse(shardSrc) as { schema?: string; units?: ProcedureUnit[] } | null) : null;
    if (shard?.schema !== "forge/trajectory-shard@1") {
      return {
        data: {
          command: "trajectory.index",
          status: "ok",
          units: 0,
          admitted: 0,
          rejected: 0,
          dropped: 0,
          sourceWatermark,
          index: "",
          diagnostics: [{ ruleId: "TRAJ-03", severity: "error", message: `${importPath} is not a forge/trajectory-shard@1` }],
        },
        summary: `TRAJ-03 ${importPath} is not a forge/trajectory-shard@1`,
        exitCode: 1,
      };
    }
    for (const u of shard.units ?? []) {
      if (!unitsById.has(u.id)) {
        units.push({ ...u, producer: { ...u.producer, origin: "vendored" }, source: `${importPath}#vendored` });
      }
    }
  }

  // RFC-1475 TRAJ-04 — re-resolve every unit's verdictRef post-admission;
  // an unresolvable or no-longer-green binding drops the unit (warning-level).
  let dropped = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    if (!(await verdictRefResolvesGreen(u.producer.verdictRef, root, io))) {
      units.splice(i, 1);
      dropped++;
    }
  }

  const indexDir = path.join(root, "docs", ".index", "trajectory");
  await io.mkdir(indexDir).catch(() => {});
  const indexRel = "docs/.index/trajectory/units.yaml";
  await io.writeFile(
    path.join(root, indexRel),
    yamlStringify({ schema: "forge/trajectory-index@1", sourceWatermark, units }) + "\n",
  );

  if (exportPath) {
    // RFC-1475 F10 — materialize the {workshopId, sessionClass} bucket table
    // so a vendored shard carries its own trust provenance.
    const buckets = new Map<string, { workshopId: string; sessionClass: string; helped: number; hurt: number }>();
    for (const u of units) {
      const key = `${u.producer.workshopId}|${u.producer.sessionClass ?? "adhoc"}`;
      const bucket = buckets.get(key) ?? {
        workshopId: u.producer.workshopId,
        sessionClass: u.producer.sessionClass ?? "adhoc",
        helped: 0,
        hurt: 0,
      };
      bucket.helped += u.usedBy.helped;
      bucket.hurt += u.usedBy.hurt;
      buckets.set(key, bucket);
    }
    const producerStats = [...buckets.values()].map((b) => ({
      ...b,
      trust: b.helped + b.hurt > 0 ? Number((b.helped / (b.helped + b.hurt)).toFixed(3)) : 0.5,
    }));
    const shard = { schema: "forge/trajectory-shard@1", exportedFrom: "werkstatt", units, producerStats };
    await io.writeFile(path.join(root, exportPath), yamlStringify(shard) + "\n");
  }
  return {
    data: {
      command: "trajectory.index",
      status: "ok",
      units: units.length,
      admitted,
      rejected,
      dropped,
      sourceWatermark,
      index: indexRel,
      diagnostics:
        dropped > 0
          ? [{ ruleId: "TRAJ-04", severity: "warning", message: `${dropped} unit(s) dropped — verdictRef no longer resolves green` }]
          : undefined,
    },
    summary: `${units.length} unit(s): ${admitted} green admitted, ${rejected} rejected${dropped > 0 ? `, ${dropped} dropped (TRAJ-04)` : ""} → ${indexRel}${exportPath ? ` + shard ${exportPath}` : ""}`,
    exitCode: 0,
  };
}
