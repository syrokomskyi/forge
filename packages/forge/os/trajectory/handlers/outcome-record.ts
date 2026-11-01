/*
<MODULE_CONTRACT>
<purpose>
RFC-1472: trajectory.outcome.record --recall <id> --helped|--hurt [--note] —
the marginal-utility feedback loop: labels feed utilityScore re-ranking and
per-producer trust (helped/(helped+hurt)).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1475: TRAJ-05 unknown recall id, append-only outcomes.jsonl, recalls.jsonl lookup, sourceWatermark-preserving units.yaml update</item>
  <item>RFC-1472: trajectory.outcome.record helped/hurt labels → utilityScore + producerTrust</item>
  <item>RFC-1472: trajectory.index + trajectory.recall + trajectory.outcome.record — procedural-memory retrieval with green-verdict admission</item>
  <item>RFC-1475: apply review round-1 findings — vendored-label replay order, real workshopId, cache bypass, TRAJ-06 diagnostics, ENOENT-only journal reads</item>
  <item>RFC-1475: apply review round-2 findings — element-shape index validation, early-return TRAJ-06 diagnostics, declared forge.yaml/journal reads, hardened shard-unit shape</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import { appendJsonl, isEnoent, readOutcomesJournal, readRecallsJournal } from "./journal-io.ts";
import type { ProcedureUnit } from "./trajectory-index.ts";
import { isShardUnit } from "./trajectory-index.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface OutcomeData {
  command: "trajectory.outcome.record";
  status: "ok";
  recallId: string;
  helped: number;
  hurt: number;
  unitUpdates: number;
  diagnostics?: { ruleId?: string; severity?: string; message?: string }[];
}

export async function runOutcomeRecord(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<OutcomeData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const recallId = String(input.flags["recall"] ?? "");
  const helped = input.flags["helped"] === true;
  const hurt = input.flags["hurt"] === true;
  const note = String(input.flags["note"] ?? "");
  if (!recallId || (!helped && !hurt)) {
    return { data: { command: "trajectory.outcome.record", status: "ok", recallId, helped: 0, hurt: 0, unitUpdates: 0 }, summary: "missing --recall or --helped/--hurt", exitCode: 1 };
  }
  const journalRead = await readRecallsJournal(root, io);
  const outcomesRead = await readOutcomesJournal(root, io);
  for (const warning of [...journalRead.warnings, ...outcomesRead.warnings]) context.logger.warn(warning);
  const journalTruncated = journalRead.truncated || outcomesRead.truncated;
  const trah06 = journalTruncated
    ? [{ ruleId: "TRAJ-06", severity: "warning", message: "trajectory journal carried a truncated or malformed tail record — partial record dropped, journal survives" }]
    : [];
  if (journalTruncated) {
    context.logger.warn("TRAJ-06 trajectory journal carried a truncated or malformed tail record — partial record dropped, journal survives");
  }
  const recall = journalRead.records.find((r) => r.id === recallId);
  if (!recall) {
    return {
      data: {
        command: "trajectory.outcome.record",
        status: "ok",
        recallId,
        helped: 0,
        hurt: 0,
        unitUpdates: 0,
        diagnostics: [{ ruleId: "TRAJ-05", severity: "error", message: `recall ${recallId} not found` }, ...trah06],
      },
      summary: `TRAJ-05 recall ${recallId} not found`,
      exitCode: 1,
    };
  }
  const indexRel = path.join(root, "docs", ".index", "trajectory", "units.yaml");
  const indexSrc = await io.readFile(indexRel).catch((e) => {
    if (isEnoent(e)) return null;
    throw e;
  });
  if (indexSrc === null) {
    return {
      data: {
        command: "trajectory.outcome.record",
        status: "ok",
        recallId,
        helped: 0,
        hurt: 0,
        unitUpdates: 0,
        diagnostics: [{ ruleId: "TRAJ-01", severity: "error", message: "units index missing" }, ...trah06],
      },
      summary: "TRAJ-01 units index missing",
      exitCode: 1,
    };
  }
  let parsed: { sourceWatermark?: string; units?: ProcedureUnit[] } | null;
  try {
    parsed = yamlParse(indexSrc) as typeof parsed;
  } catch {
    parsed = null;
  }
  const units = parsed !== null && typeof parsed === "object" && Array.isArray(parsed.units)
    ? parsed.units.filter(isShardUnit)
    : null;
  if (units === null || units.length === 0) {
    return {
      data: {
        command: "trajectory.outcome.record",
        status: "ok",
        recallId,
        helped: 0,
        hurt: 0,
        unitUpdates: 0,
        diagnostics: [{ ruleId: "TRAJ-02", severity: "error", message: "units index unparseable, empty, or not a unit index — rerun trajectory.index" }, ...trah06],
      },
      summary: "TRAJ-02 units index unusable",
      exitCode: 1,
    };
  }
  // `recalled` mirrors replay semantics — one count per recall record, so a
  // second label for the same recallId must not double-count until rebuild.
  const firstLabel = !outcomesRead.records.some((o) => o.recallId === recallId);
  let updated = 0;
  for (const uid of recall.unitsReturned ?? []) {
    const u = units.find((x) => x.id === uid);
    if (!u) continue;
    if (firstLabel) u.usedBy.recalled++;
    if (helped) u.usedBy.helped++;
    if (hurt) u.usedBy.hurt++;
    u.utilityScore = u.usedBy.helped - u.usedBy.hurt;
    updated++;
  }
  // RFC-1475 F11 — append-only outcomes.jsonl: appendFile only, never
  // read-modify-write; the eager units.yaml update keeps recall-time
  // trust buckets fresh without an index rebuild (plan step 4).
  await appendJsonl(
    io,
    path.join(root, "docs", ".index", "trajectory", "outcomes.jsonl"),
    { recallId, helped, hurt, note, at: new Date().toISOString() },
  );
  await io.writeFile(
    indexRel,
    yamlStringify({ schema: "forge/trajectory-index@1", sourceWatermark: parsed?.sourceWatermark, units }) + "\n",
  );
  return {
    data: {
      command: "trajectory.outcome.record",
      status: "ok",
      recallId,
      helped: helped ? 1 : 0,
      hurt: hurt ? 1 : 0,
      unitUpdates: updated,
      diagnostics: trah06.length > 0 ? trah06 : undefined,
    },
    summary: `recorded ${helped ? "helped" : "hurt"} for ${recallId} — ${updated} unit(s) updated`,
    exitCode: 0,
  };
}
