/*
<MODULE_CONTRACT>
<purpose>RFC-1475 producer-trust tests — {workshopId, sessionClass} bucket aggregation (AC-6), vendored isolation, sparse-bucket 0.5, producerStats shard materialization.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
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
    // Recall k=1 returns exactly one unit — its {workshopId, sessionClass}
    // bucket receives the hurt label; the other bucket stays at 0.5. The
    // labeled bucket is read off the recall result, not a hardcoded class —
    // the winner depends on recency vs wall clock and ages out otherwise.
    const recall = await runTrajectoryRecall(flags({ task: "reconcile", k: 1 }), ctx());
    const labeled = recall.data?.units[0]?.producer.sessionClass ?? "adhoc";
    await runOutcomeRecord(flags({ recall: recall.data?.recallId, hurt: true }), ctx());
    const re = await runTrajectoryRecall(flags({ task: "reconcile", k: 20 }), ctx());
    const labeledUnits = re.data?.units.filter((u) => u.producer.sessionClass === labeled) ?? [];
    const otherUnits = re.data?.units.filter((u) => u.producer.sessionClass !== labeled) ?? [];
    expect(labeledUnits.length).toBeGreaterThan(0);
    expect(otherUnits.length).toBeGreaterThan(0);
    for (const u of labeledUnits) {
      expect(u.reasons.find((r) => r.startsWith("trust:"))).toBe("trust:0.00");
    }
    for (const u of otherUnits) {
      expect(u.reasons.find((r) => r.startsWith("trust:"))).toBe("trust:0.50");
    }
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
    expect(recall.data?.units[0]?.producer.workshopId).toBe(basename(root));
    await runOutcomeRecord(flags({ recall: recall.data?.recallId, hurt: true }), ctx());
    const re = await runTrajectoryRecall(flags({ task: "reconcile", k: 20 }), ctx());
    const vendored = re.data?.units.find((u) => u.id === "trajectory:vendored");
    const vendoredTrust = vendored?.reasons.find((r) => r.startsWith("trust:"));
    // other-shop/adhoc carried helped:3 hurt:1 → trust 0.75 regardless of werkstatt labels.
    expect(vendoredTrust).toBe("trust:0.75");
  });

  test("unlabeled bucket scores at the neutral 0.5 — never below a fresh producer", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const re = await runTrajectoryRecall(flags({ task: "reconcile", k: 20 }), ctx());
    for (const u of re.data?.units ?? []) {
      expect(u.reasons.find((r) => r.startsWith("trust:"))).toBe("trust:0.50");
    }
  });

  test("shard export materializes the bucket table into producerStats", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const out = "docs/.index/trajectory/export.yaml";
    await runTrajectoryIndex(flags({ export: out }), ctx());
    const shard = await readFile(join(root, out), "utf8");
    expect(shard).toContain("producerStats:");
    expect(shard).toContain(`workshopId: ${basename(root)}`);
    expect(shard).toContain(`exportedFrom: ${basename(root)}`);
    expect(shard).toContain("sessionClass: mission");
    expect(shard).toContain("sessionClass: adhoc");
  });
});
