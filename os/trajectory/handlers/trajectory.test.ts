/*
<MODULE_CONTRACT>
<purpose>RFC-1472 trajectory tests — green-admission gating, situation-similarity recall, outcome.record feeds utilityScore.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTrajectoryIndex } from "./trajectory-index.ts";
import { runTrajectoryRecall } from "./trajectory-recall.ts";
import { runOutcomeRecord } from "./outcome-record.ts";
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trajectory-"));
  await mkdir(join(root, "docs", "sessions"), { recursive: true });
  await writeFile(join(root, "docs", "sessions", "2026-10-30-12-00-00-aaaaaa.md"), `---
id: s-green
verdict: green
taskKind: reconcile
commands: [mission.reconcile, sternsystem.sync]
decisions: ["merged in the workpiece"]
filesChanged: [missions/dp7/wip.md]
date: 2026-10-30
---
body
`);
  await writeFile(join(root, "docs", "sessions", "2026-10-29-12-00-00-bbbbbb.md"), `---
id: s-red
verdict: red
taskKind: deploy
commands: [mission.deploy]
date: 2026-10-29
---
body
`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("trajectory.index (RFC-1472)", () => {
  test("only green-verified sessions produce units — red admitted nothing", async () => {
    const res = await runTrajectoryIndex(flags({}), ctx());
    expect(res.data?.units).toBe(1);
    expect(res.data?.admitted).toBe(1);
    expect(res.data?.rejected).toBe(1);
  });
});

describe("trajectory.recall (RFC-1472)", () => {
  test("task-matched unit ranks top + journaled", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const res = await runTrajectoryRecall(flags({ task: "reconcile diverged workpiece", k: 5 }), ctx());
    expect(res.data?.units[0]?.producer.sessionId).toBe("s-green");
    expect(res.data?.recallId.length).toBeGreaterThan(0);
    expect(res.exitCode).toBe(0);
  });

  test("missing index → TRAJ-01", async () => {
    const res = await runTrajectoryRecall(flags({ task: "x" }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("TRAJ-01");
  });
});

describe("trajectory.outcome.record (RFC-1472)", () => {
  test("helped label → utilityScore +1 on the recalled unit", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const recall = await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    const rec = await runOutcomeRecord(flags({ recall: recall.data?.recallId, helped: true }), ctx());
    expect(rec.data?.unitUpdates).toBe(1);
    const re2 = await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    expect(re2.data?.units[0]?.usedBy.helped).toBe(1);
    expect(re2.data?.units[0]?.utilityScore).toBe(1);
  });
});
