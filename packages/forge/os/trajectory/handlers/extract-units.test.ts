/*
<MODULE_CONTRACT>
<purpose>extract-units coverage for trajectory.index — green-admission gating, situation-similarity recall, and outcome.record utilityScore feeds.</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-trajectory</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTrajectoryIndex } from "./trajectory-index.ts";


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

describe("extract-units (RFC-1472)", () => {
  test("situation key binds taskKind + pathClasses + recentActions; continuation carries commands + outcomeHash", async () => {
    const res = await runTrajectoryIndex(flags({}), ctx());
    expect(res.data?.units).toBeGreaterThanOrEqual(1);
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("taskKind: reconcile");
    expect(index).toContain("touchedPathClasses:");
    expect(index).toContain("commandSequence:");
    expect(index).toContain("outcomeHash:");
  });
});
