/*
<MODULE_CONTRACT>
<purpose>RFC-1472 trajectory tests — green-admission gating, situation-similarity recall, outcome.record feeds utilityScore.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
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
    expect(res.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-01");
  });
});

describe("TRAJ-02 staleness semantics (RFC-1475 AC-4, AC-5)", () => {
  async function writeIndex(unitsYaml: string): Promise<void> {
    await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
    await writeFile(join(root, "docs", ".index", "trajectory", "units.yaml"), unitsYaml);
  }

  test("present-but-empty index → TRAJ-02, never TRAJ-01", async () => {
    await writeIndex("schema: forge/trajectory-index@1\nsourceWatermark: docs/sessions/9999.md\nunits: []\n");
    const res = await runTrajectoryRecall(flags({ task: "x" }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("TRAJ-02");
    expect(res.summary).not.toContain("TRAJ-01");
    expect(res.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-02");
  });

  test("index without sourceWatermark counts as stale → TRAJ-02", async () => {
    await writeIndex(`schema: forge/trajectory-index@1
units:
  - id: trajectory:u1
    kind: trajectory
    situation: {taskKind: reconcile, touchedPathClasses: [], recentActions: [reconcile]}
    continuation: {commandSequence: [], decisions: [], outcomeHash: abc}
    producer: {workshopId: werkstatt, sessionId: u1, completedAt: "2026-10-01", verdictRef: "verdict:green"}
    source: docs/sessions/x.md
    tokens: 10
    text: reconcile
    usedBy: {recalled: 0, helped: 0, hurt: 0}
    utilityScore: 0
`);
    const res = await runTrajectoryRecall(flags({ task: "x" }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("TRAJ-02");
    expect(res.summary).toContain("predates watermark support");
  });

  test("sourceWatermark older than the newest session source → TRAJ-02", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    // A newer session file lands after the index was built → stale.
    await writeFile(join(root, "docs", "sessions", "2026-10-31-12-00-00-dddddd.md"), `---
id: s-newer
verdict: green
taskKind: deploy
date: 2026-10-31
---
body
`);
    const res = await runTrajectoryRecall(flags({ task: "x" }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("TRAJ-02");
    expect(res.summary).toContain("stale");
  });

  test("fresh index passes the watermark gate — exit 0", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const res = await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    expect(res.exitCode).toBe(0);
  });

  test("non-string sourceWatermark counts as stale → TRAJ-02 (R4-2)", async () => {
    await writeIndex(`schema: forge/trajectory-index@1
sourceWatermark: 42
units:
  - id: trajectory:u1
    kind: trajectory
    situation: {taskKind: reconcile, touchedPathClasses: [], recentActions: [reconcile]}
    continuation: {commandSequence: [], decisions: [], outcomeHash: abc}
    producer: {workshopId: w, sessionId: u1, completedAt: "2026-10-01", verdictRef: "verdict:green"}
    source: docs/sessions/x.md
    tokens: 10
    text: reconcile
    usedBy: {recalled: 0, helped: 0, hurt: 0}
    utilityScore: 0
`);
    const res = await runTrajectoryRecall(flags({ task: "x" }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-02");
  });

  test("corrupt units.yaml → TRAJ-02, never a raw exception", async () => {
    await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
    await writeFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "units: {a: map, not: a-list}\n");
    const res = await runTrajectoryRecall(flags({ task: "x" }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("TRAJ-02");
    expect(res.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-02");
    await writeFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "units: [unclosed\n  - : :");
    const res2 = await runTrajectoryRecall(flags({ task: "x" }), ctx());
    expect(res2.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-02");
  });
});

describe("recalls.jsonl append-only journal (RFC-1475 AC-10)", () => {
  test("two recalls append two JSONL lines — no read-modify-write", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    await runTrajectoryRecall(flags({ task: "deploy" }), ctx());
    const lines = (await readFile(join(root, "docs", ".index", "trajectory", "recalls.jsonl"), "utf8")).trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).id).toMatch(/^R-/);
    expect(JSON.parse(lines[1]!).task).toBe("deploy");
  });

  test("a truncated last line drops only the partial record (TRAJ-06)", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    const jsonl = join(root, "docs", ".index", "trajectory", "recalls.jsonl");
    await appendFile(jsonl, `{"id":"R-broken`);
    const warns: string[] = [];
    const capture = { ...ctx(), logger: { info() {}, warn(m: string) { warns.push(m); }, error() {}, success() {}, section() {} } } as unknown as ForgeRuntimeContext;
    const res = await runTrajectoryRecall(flags({ task: "reconcile" }), capture);
    expect(res.exitCode).toBe(0);
    expect(warns.some((w) => w.includes("TRAJ-06"))).toBe(true);
    // TRAJ-06 also lands in data.diagnostics — the RFC-1474 counters journal
    // must count the firing, not just the console warning.
    expect(res.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-06");
    const lines = (await readFile(jsonl, "utf8")).trim().split("\n");
    expect(lines.length).toBe(3);
  });

  test("recalls.yaml migrates lazily — outcome.record resolves the migrated recall id", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
    await writeFile(
      join(root, "docs", ".index", "trajectory", "recalls.yaml"),
      "schema: forge/trajectory-recalls@1\nrecalls:\n  - {id: R-legacy-1, task: reconcile, unitsReturned: [\"trajectory:s-green\"], at: \"2026-10-01T00:00:00Z\"}\n",
    );
    const res = await runOutcomeRecord(flags({ recall: "R-legacy-1", helped: true }), ctx());
    expect(res.exitCode).toBe(0);
    expect(res.data?.unitUpdates).toBe(1);
    const lines = (await readFile(join(root, "docs", ".index", "trajectory", "recalls.jsonl"), "utf8")).trim().split("\n");
    expect(lines.some((l) => l.includes("R-legacy-1"))).toBe(true);
  });

  test("crafted non-string id dedups — migration converges instead of unbounded re-append", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const jsonl = join(root, "docs", ".index", "trajectory", "recalls.jsonl");
    await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
    await writeFile(
      join(root, "docs", ".index", "trajectory", "recalls.yaml"),
      "schema: forge/trajectory-recalls@1\nrecalls:\n  - {id: {nested: 1}, task: x, unitsReturned: [], at: \"2026-10-01T00:00:00Z\"}\n",
    );
    await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    const first = (await readFile(jsonl, "utf8")).trim().split("\n").length;
    await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    const second = (await readFile(jsonl, "utf8")).trim().split("\n").length;
    // Second recall appends only its own journal line — the object-id record
    // must not be re-migrated (it dedups under the "" key on both sides).
    expect(second).toBe(first + 1);
  });
});

