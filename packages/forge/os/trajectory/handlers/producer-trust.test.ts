/*
<MODULE_CONTRACT>
<purpose>RFC-1475 producer-trust tests — {workshopId, sessionClass} bucket aggregation (AC-6), vendored isolation, sparse-bucket 0.5, producerStats shard materialization.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTrajectoryIndex } from "./trajectory-index.ts";
import { runTrajectoryRecall } from "./trajectory-recall.ts";
import { runOutcomeRecord } from "./outcome-record.ts";
import type { ProcedureUnit } from "./trajectory-index.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown> = {}) {
  return { argv: [], flags: f } as never;
}

async function writeSession(name: string, frontmatter: string): Promise<void> {
  await writeFile(join(root, "docs", "sessions", name), `---\n${frontmatter}\n---\nbody\n`);
}

function vendoredUnit(id: string, producer: Partial<ProcedureUnit["producer"]> = {}, usedBy: Partial<ProcedureUnit["usedBy"]> = {}, taskKind = "deploy") {
  return {
    id,
    kind: "trajectory",
    situation: { taskKind, touchedPathClasses: [], recentActions: [taskKind] },
    continuation: { commandSequence: ["mission.reconcile"], decisions: [], outcomeHash: "abc123" },
    producer: {
      workshopId: "other-shop",
      sessionId: id,
      completedAt: "2026-10-01",
      verdictRef: "verdict:green",
      sessionClass: "adhoc",
      origin: "vendored",
      ...producer,
    },
    source: "shard",
    tokens: 10,
    text: `${id} ${taskKind} vendored`,
    usedBy: { recalled: 0, helped: 0, hurt: 0, ...usedBy },
    utilityScore: 0,
  } satisfies ProcedureUnit;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trajectory-trust-"));
  await mkdir(join(root, "docs", "sessions"), { recursive: true });
  await writeSession("2026-10-30-12-00-00-aaaaaa.md", `id: s-mission
verdict: green
types: [mission]
taskKind: reconcile
commands: [mission.reconcile]
date: 2026-10-30`);
  await writeSession("2026-10-29-12-00-00-bbbbbb.md", `id: s-adhoc
verdict: green
taskKind: reconcile
commands: [mission.reconcile]
date: 2026-10-29`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("producer trust buckets (RFC-1475 AC-6)", () => {
  test("units in one {workshopId, sessionClass} bucket share the aggregated trust", async () => {
    await writeSession("2026-10-28-12-00-00-cccccc.md", `id: s-adhoc-2
verdict: green
taskKind: reconcile
commands: [mission.reconcile]
date: 2026-10-28`);
    await runTrajectoryIndex(flags({}), ctx());
    const recall = await runTrajectoryRecall(flags({ task: "reconcile", k: 20 }), ctx());
    const adhoc = recall.data?.units.filter((u) => u.producer.sessionId.startsWith("s-adhoc"));
    expect(adhoc?.length).toBe(2);
    // Label the recall — helped lands on the returned adhoc units.
    await runOutcomeRecord(flags({ recall: recall.data?.recallId, helped: true }), ctx());
    const re = await runTrajectoryRecall(flags({ task: "reconcile", k: 20 }), ctx());
    const trustReasons = re.data?.units
      .filter((u) => u.producer.sessionClass === "adhoc")
      .map((u) => u.reasons.find((r) => r.startsWith("trust:")));
    expect(trustReasons?.every((t) => t === "trust:1.00")).toBe(true);
  });

  test("a label on one bucket never leaks into another bucket", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    // Recall matching only the mission-class unit (task token hits only its recentActions/taskKind bucket — both share reconcile, so filter by returned ids instead).
    const recall = await runTrajectoryRecall(flags({ task: "reconcile", k: 1 }), ctx());
    await runOutcomeRecord(flags({ recall: recall.data?.recallId, hurt: true }), ctx());
    const re = await runTrajectoryRecall(flags({ task: "reconcile", k: 20 }), ctx());
    const mission = re.data?.units.find((u) => u.producer.sessionClass === "mission");
    const adhoc = re.data?.units.find((u) => u.producer.sessionClass === "adhoc");
    // The hurt label lands only on the returned unit's bucket; the other bucket stays unlabeled (no trust: reason).
    const missionTrust = mission?.reasons.find((r) => r.startsWith("trust:"));
    const adhocTrust = adhoc?.reasons.find((r) => r.startsWith("trust:"));
    expect(missionTrust ?? adhocTrust).toBeDefined();
    expect(missionTrust === undefined || adhocTrust === undefined).toBe(true);
  });

  test("vendored unit scores under its origin's bucket — werkstatt labels never smear across", async () => {
    const { stringify } = await import("yaml");
    const shard = "docs/.index/trajectory/incoming.yaml";
    await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
    await writeFile(
      join(root, shard),
      stringify({
        schema: "forge/trajectory-shard@1",
        units: [vendoredUnit("trajectory:vendored", {}, { helped: 3, hurt: 1, recalled: 4 })],
      }) + "\n",
    );
    await runTrajectoryIndex(flags({ import: shard }), ctx());
    // Label the local bucket — the vendored unit does not match this task, so
    // the hurt label lands only on the returned werkstatt unit.
    const recall = await runTrajectoryRecall(flags({ task: "reconcile", k: 1 }), ctx());
    expect(recall.data?.units[0]?.producer.workshopId).toBe("werkstatt");
    await runOutcomeRecord(flags({ recall: recall.data?.recallId, hurt: true }), ctx());
    const re = await runTrajectoryRecall(flags({ task: "reconcile", k: 20 }), ctx());
    const vendored = re.data?.units.find((u) => u.id === "trajectory:vendored");
    const vendoredTrust = vendored?.reasons.find((r) => r.startsWith("trust:"));
    // other-shop/adhoc carried helped:3 hurt:1 → trust 0.75 regardless of werkstatt labels.
    expect(vendoredTrust).toBe("trust:0.75");
  });

  test("unlabeled bucket scores neutral — no trust: reason (sparse-bucket 0.5)", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const re = await runTrajectoryRecall(flags({ task: "reconcile", k: 20 }), ctx());
    for (const u of re.data?.units ?? []) {
      expect(u.reasons.find((r) => r.startsWith("trust:"))).toBeUndefined();
    }
  });

  test("shard export materializes the bucket table into producerStats", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const out = "docs/.index/trajectory/export.yaml";
    await runTrajectoryIndex(flags({ export: out }), ctx());
    const shard = await readFile(join(root, out), "utf8");
    expect(shard).toContain("producerStats:");
    expect(shard).toContain("workshopId: werkstatt");
    expect(shard).toContain("sessionClass: mission");
    expect(shard).toContain("sessionClass: adhoc");
  });
});
