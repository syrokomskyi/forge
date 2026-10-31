/*
<MODULE_CONTRACT>
<purpose>RFC-1472 trajectory tests — green-admission gating, situation-similarity recall, outcome.record feeds utilityScore.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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
  await mkdir(join(root, "docs", "sessions", "archive"), { recursive: true });
  await writeFile(join(root, "docs", "sessions", "archive", "2026-08-01-12-00-00-cccccc.md"), `---
id: s-archived
commits: [abc123]
commands: [mission.close]
types: [archive]
date: 2026-08-01
---
body
`);
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
    expect(res.data?.units).toBe(2);
    expect(res.data?.admitted).toBe(2);
    expect(res.data?.rejected).toBe(1);
  });

  test("archived units cite docs/sessions/archive/, not docs/sessions/", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("source: docs/sessions/archive/2026-08-01-12-00-00-cccccc.md");
    expect(index).not.toContain("source: docs/sessions/2026-08-01-12-00-00-cccccc.md");
  });

  test("outcome labels survive a rebuild — the compounding asset isn't zeroed", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    // Record helped on the unit, rebuild, assert the stat survived.
    const recall = await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    const rec = await runOutcomeRecord(flags({ recall: recall.data?.recallId, helped: true }), ctx());
    expect(rec.data?.unitUpdates).toBe(2);
    await runTrajectoryIndex(flags({}), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("helped: 1");
  });

  test("index file carries the procedure unit (situation + continuation + producer)", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("forge/trajectory-index@1");
    expect(index).toContain("trajectory:s-green");
  });
});
