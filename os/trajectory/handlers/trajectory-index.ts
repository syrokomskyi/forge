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
  <item>RFC-1472: apply r1 repairs — outcomes replay on rebuild, real schema fields, anchored GREEN_RE, shard import, unique recallIds, archive coverage, trajectory kind</item>
  <item>RFC-1472: apply r2 repairs — archive-source provenance, outcome-replay + provenance regression tests</item>
  <item>RFC-1475: apply review round-1 findings — vendored-label replay order, real workshopId, cache bypass, TRAJ-06 diagnostics, ENOENT-only journal reads</item>
  <item>RFC-1475: apply review round-2 findings — element-shape index validation, early-return TRAJ-06 diagnostics, declared forge.yaml/journal reads, hardened shard-unit shape</item>
  <item>RFC-1475: apply review round-3 findings — element-type guards on journal/unit arrays, declared yaml journal reads, honest TRAJ-02 empty-vs-malformed messages, RFC deviations recorded</item>
  <history>RFC-1472, RFC-1475</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { createHash } from "node:crypto";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { loadForgeConfig } from "../../../src/config/forge-config.ts";
import { listSessionFiles, listArchivedSessionFiles, readAndParseSession } from "../../session/frontmatter-io.ts";
import { isEnoent, journalUnitIds, readOutcomesJournal, readRecallsJournal } from "./journal-io.ts";
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
  const src = await io.readFile(path.join(root, verdictRef)).catch((e) => {
    if (isEnoent(e)) return null;
    throw e;
  });
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

/**
 * The local producer identity (RFC-1475 F10): forge.yaml `project.name` — a
 * vendored shard's bucket must key on a real workshop id, not a hardcoded
 * literal that collapses every consumer into one bucket. Fall back to the
 * workspace dir name when no forge.yaml exists (fixture/test roots).
 */
function localWorkshopId(root: string, warn?: (msg: string) => void): string {
  try {
    return loadForgeConfig(root).project.name || path.basename(root);
  } catch {
    const fallback = path.basename(root);
    warn?.(`forge.yaml missing or invalid — workshopId falls back to workspace dir name "${fallback}"`);
    return fallback;
  }
}

/**
 * Rewrite a local artifact-path verdictRef into portable `verdict:<value>`
 * form on shard export — the path only resolves inside the origin workspace,
 * and a consumer's TRAJ-04 gate would drop every artifact-bound unit. The
 * origin attests the verdict value it resolved; the consumer's producer
 * bucket decides how much that attestation weighs.
 */
async function exportableVerdictRef(
  unit: ProcedureUnit,
  root: string,
  io: ReturnType<typeof resolveIo>,
): Promise<ProcedureUnit> {
  const ref = unit.producer.verdictRef;
  if (ref === "signal:commits" || ref.startsWith("verdict:")) return unit;
  const src = await io.readFile(path.join(root, ref)).catch((e) => {
    if (isEnoent(e)) return null;
    throw e;
  });
  const verdict = (() => {
    try {
      return src === null ? null : (JSON.parse(src) as { verdict?: unknown }).verdict;
    } catch {
      return null;
    }
  })();
  if (typeof verdict !== "string" || verdict.length === 0) return unit;
  return { ...unit, producer: { ...unit.producer, verdictRef: `verdict:${verdict}` } };
}

/**
 * Minimal shard-unit shape — anything less crashes the drop/bucket/score
 * loops. Also guards the numeric usedBy/utilityScore fields and sessionClass
 * so a crafted shard cannot inject NaN trust or smear a foreign bucket key.
 */
export function isShardUnit(u: unknown): u is ProcedureUnit {
  if (u === null || typeof u !== "object") return false;
  const p = u as ProcedureUnit;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((e) => typeof e === "string");
  return (
    typeof p.id === "string" &&
    p.producer !== null && typeof p.producer === "object" &&
    typeof p.producer.verdictRef === "string" &&
    typeof p.producer.workshopId === "string" &&
    typeof p.producer.sessionId === "string" &&
    typeof p.producer.completedAt === "string" &&
    (p.producer.sessionClass === undefined || p.producer.sessionClass === "mission" || p.producer.sessionClass === "adhoc") &&
    p.usedBy !== null && typeof p.usedBy === "object" &&
    Number.isFinite(p.usedBy.helped) && Number.isFinite(p.usedBy.hurt) && Number.isFinite(p.usedBy.recalled) &&
    Number.isFinite(p.utilityScore) &&
    p.situation !== null && typeof p.situation === "object" &&
    typeof p.situation.taskKind === "string" &&
    strings(p.situation.recentActions) &&
    strings(p.situation.touchedPathClasses) &&
    p.continuation !== null && typeof p.continuation === "object" &&
    strings(p.continuation.commandSequence) &&
    typeof p.text === "string"
  );
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
  const workshopId = localWorkshopId(root, (m) => context.logger.warn(m));
  const sessionFilter = input.flags["session"] as string | undefined;
  const since = input.flags["since"] as string | undefined;
  const exportPath = input.flags["export"] as string | undefined;

  const sessionsDir = path.join(root, "docs", "sessions");
  const archiveBase = path.join(sessionsDir, "archive");
  const allFiles = [
    ...(await listSessionFiles(sessionsDir).catch(() => [])).map((rel) => ({ rel, base: sessionsDir, prefix: "docs/sessions" })),
    ...(await listArchivedSessionFiles(sessionsDir).catch(() => [])).map((rel) => ({ rel, base: archiveBase, prefix: "docs/sessions/archive" })),
  ];
  const files = allFiles
    .filter((f) => !sessionFilter || f.rel.includes(sessionFilter))
    .filter((f) => !since || f.rel >= since);

  // RFC-1475 F6 — the watermark is the newest session FILENAME (basename)
  // across the whole corpus: recall compares it like-for-like against the
  // newest session file, so a filtered --session/--since build still reports
  // corpus freshness (its watermark answers "how recent is the corpus this
  // index was built against", not "how many units"). Full-path compare would
  // let `archive/` outrank every live file ("a" > "2") and mask real
  // staleness — filenames are the like-for-like key.
  const sourceWatermark = allFiles.reduce(
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
      const evidenceSrc = await io.readFile(path.join(root, evidenceRel)).catch((e) => {
        if (isEnoent(e)) return null;
        throw e;
      });
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
        workshopId,
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

  // F3 — merge a vendored shard BEFORE journal replay so labels naming
  // vendored unit ids resolve on rebuild (origin: vendored, trust: review
  // per RFC §4). Malformed units are skipped — anything less than the minimal
  // shape crashes the drop/bucket loops.
  const localIds = new Set(units.map((u) => u.id));
  const importPath = input.flags["import"] as string | undefined;
  let skippedShardUnits = 0;
  if (importPath) {
    const shardSrc = await io.readFile(path.join(root, importPath)).catch((e) => {
      if (isEnoent(e)) return null;
      throw e;
    });
    const shard = shardSrc ? (yamlParse(shardSrc) as { schema?: string; units?: unknown[] } | null) : null;
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
    for (const candidate of shard.units ?? []) {
      if (!isShardUnit(candidate)) {
        skippedShardUnits++;
        continue;
      }
      if (!localIds.has(candidate.id)) {
        units.push({ ...candidate, producer: { ...candidate.producer, origin: "vendored" }, source: `${importPath}#vendored` });
        localIds.add(candidate.id);
      }
    }
    if (skippedShardUnits > 0) {
      context.logger.warn(`${skippedShardUnits} shard unit(s) skipped — malformed or missing required fields (id/producer/usedBy/situation/continuation/text)`);
    }
  }

  // Replay prior outcome labels — utility stats are the compounding asset;
  // a rebuild must not zero them (the JSONL journals are the durable asset).
  // Runs after the shard merge so journal records naming vendored ids
  // resolve against the merged set.
  const outcomesRead = await readOutcomesJournal(root, io);
  const recallsRead = await readRecallsJournal(root, io);
  for (const warning of [...outcomesRead.warnings, ...recallsRead.warnings]) {
    context.logger.warn(warning);
  }
  const journalTruncated = outcomesRead.truncated || recallsRead.truncated;
  if (journalTruncated) {
    context.logger.warn("TRAJ-06 trajectory journal carried a truncated or malformed tail record — partial record dropped, journal survives");
  }
  const outcomes = outcomesRead.records;
  const recalls = recallsRead.records;
  const unitsById = new Map(units.map((u) => [u.id, u]));
  for (const r of recalls) {
    for (const uid of journalUnitIds(r)) {
      const u = unitsById.get(uid);
      if (u) u.usedBy.recalled++;
    }
  }
  const recallUnits = new Map(recalls.map((r) => [r.id, journalUnitIds(r)]));
  for (const o of outcomes) {
    for (const uid of recallUnits.get(o.recallId ?? "") ?? []) {
      const u = unitsById.get(uid);
      if (!u) continue;
      if (o.helped) u.usedBy.helped++;
      if (o.hurt) u.usedBy.hurt++;
      u.utilityScore = u.usedBy.helped - u.usedBy.hurt;
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
    // so a vendored shard carries its own trust provenance. Artifact-path
    // verdictRefs are rewritten to portable `verdict:<value>` form — the
    // origin attests the value it resolved; consumer workspaces cannot
    // re-read origin evidence paths.
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
    const exportUnits = await Promise.all(units.map((u) => exportableVerdictRef(u, root, io)));
    const shard = { schema: "forge/trajectory-shard@1", exportedFrom: workshopId, units: exportUnits, producerStats };
    await io.writeFile(path.join(root, exportPath), yamlStringify(shard) + "\n");
  }
  const diagnostics: { ruleId?: string; severity?: string; message?: string }[] = [];
  if (dropped > 0) {
    diagnostics.push({ ruleId: "TRAJ-04", severity: "warning", message: `${dropped} unit(s) dropped — verdictRef no longer resolves green` });
  }
  if (journalTruncated) {
    diagnostics.push({ ruleId: "TRAJ-06", severity: "warning", message: "trajectory journal carried a truncated or malformed tail record — partial record dropped, journal survives" });
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
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    },
    summary: `${units.length} unit(s): ${admitted} green admitted, ${rejected} rejected${dropped > 0 ? `, ${dropped} dropped (TRAJ-04)` : ""} → ${indexRel}${exportPath ? ` + shard ${exportPath}` : ""}`,
    exitCode: 0,
  };
}
