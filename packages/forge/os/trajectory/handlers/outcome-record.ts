/*
<MODULE_CONTRACT>
<purpose>
RFC-1472: trajectory.outcome.record --recall <id> --helped|--hurt [--note] —
the marginal-utility feedback loop: labels feed utilityScore re-ranking and
per-producer trust (helped/(helped+hurt)).
</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1472: trajectory.outcome.record helped/hurt labels → utilityScore + producerTrust</item>
  <item>RFC-1472: trajectory.index + trajectory.recall + trajectory.outcome.record — procedural-memory retrieval with green-verdict admission</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type { ProcedureUnit } from "./trajectory-index.ts";
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
  const journalRel = "docs/.index/trajectory/recalls.yaml";
  const journalSrc = await io.readFile(path.join(root, journalRel)).catch(() => "");
  const journal = (yamlParse(journalSrc) as { recalls?: { id?: string; unitsReturned?: string[] }[] } | null)?.recalls ?? [];
  const recall = journal.find((r) => r.id === recallId);
  if (!recall) {
    return { data: { command: "trajectory.outcome.record", status: "ok", recallId, helped: 0, hurt: 0, unitUpdates: 0 }, summary: `TRAJ-02 recall ${recallId} not found`, exitCode: 1 };
  }
  const indexRel = path.join(root, "docs", ".index", "trajectory", "units.yaml");
  const indexSrc = await io.readFile(indexRel).catch(() => null);
  if (indexSrc === null) {
    return { data: { command: "trajectory.outcome.record", status: "ok", recallId, helped: 0, hurt: 0, unitUpdates: 0 }, summary: "TRAJ-01 units index missing", exitCode: 1 };
  }
  const parsed = yamlParse(indexSrc) as { units?: ProcedureUnit[] } | null;
  const units = parsed?.units ?? [];
  let updated = 0;
  for (const uid of recall.unitsReturned ?? []) {
    const u = units.find((x) => x.id === uid);
    if (!u) continue;
    u.usedBy.recalled++;
    if (helped) u.usedBy.helped++;
    if (hurt) u.usedBy.hurt++;
    u.utilityScore = u.usedBy.helped - u.usedBy.hurt;
    updated++;
  }
  const outcomesRel = "docs/.index/trajectory/outcomes.yaml";
  const outcomesSrc = await io.readFile(path.join(root, outcomesRel)).catch(() => "");
  const outcomes = (yamlParse(outcomesSrc) as { outcomes?: unknown[] } | null)?.outcomes ?? [];
  outcomes.push({ recallId, helped, hurt, note, at: new Date().toISOString() });
  await io.writeFile(indexRel, yamlStringify({ schema: "forge/trajectory-index@1", units }) + "\n");
  await io.writeFile(path.join(root, outcomesRel), yamlStringify({ schema: "forge/trajectory-outcomes@1", outcomes }) + "\n");
  return {
    data: { command: "trajectory.outcome.record", status: "ok", recallId, helped: helped ? 1 : 0, hurt: hurt ? 1 : 0, unitUpdates: updated },
    summary: `recorded ${helped ? "helped" : "hurt"} for ${recallId} — ${updated} unit(s) updated`,
    exitCode: 0,
  };
}
