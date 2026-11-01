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

describe("RFC-1475 — sourceWatermark + JSONL replay", () => {
  test("index carries sourceWatermark = newest session filename (AC-5)", async () => {
    const res = await runTrajectoryIndex(flags({}), ctx());
    // Filename, not the full path — basenames compare like-for-like across
    // sessions/ and sessions/archive/ (a full-path compare would let
    // "archive/" outrank every live filename and mask staleness).
    expect(res.data?.sourceWatermark).toBe("2026-10-30-12-00-00-aaaaaa.md");
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("sourceWatermark: 2026-10-30-12-00-00-aaaaaa.md");
  });

  test("JSONL journals feed the replay — usedBy/utilityScore survive rebuilds (AC-8)", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    const recall = await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    await runOutcomeRecord(flags({ recall: recall.data?.recallId, helped: true }), ctx());
    // Journals are JSONL now — one record per line, no YAML rewrite.
    const outcomes = await readFile(join(root, "docs", ".index", "trajectory", "outcomes.jsonl"), "utf8");
    expect(outcomes.trim().split("\n").length).toBe(1);
    expect(JSON.parse(outcomes.trim()).recallId).toBe(recall.data?.recallId);
    const recalls = await readFile(join(root, "docs", ".index", "trajectory", "recalls.jsonl"), "utf8");
    expect(recalls.trim().split("\n").length).toBe(1);
    // Rebuild replays from the JSONL journals.
    await runTrajectoryIndex(flags({}), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("helped: 1");
    expect(index).toContain("utilityScore: 1");
  });

  test("labels on vendored units survive a rebuild — replay covers the merged set (AC-8)", async () => {
    const { stringify } = await import("yaml");
    const shard = "docs/.index/trajectory/incoming.yaml";
    await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
    await writeFile(
      join(root, shard),
      stringify({
        schema: "forge/trajectory-shard@1",
        units: [{
          id: "trajectory:vendored",
          kind: "trajectory",
          situation: { taskKind: "reconcile", touchedPathClasses: [], recentActions: ["reconcile"] },
          continuation: { commandSequence: ["mission.reconcile"], decisions: [], outcomeHash: "abc123" },
          producer: { workshopId: "other-shop", sessionId: "v1", completedAt: "2026-10-01", verdictRef: "verdict:green", sessionClass: "adhoc", origin: "vendored" },
          source: "shard",
          tokens: 10,
          text: "reconcile vendored",
          usedBy: { recalled: 0, helped: 0, hurt: 0 },
          utilityScore: 0,
        }],
      }) + "\n",
    );
    await runTrajectoryIndex(flags({ import: shard }), ctx());
    const recall = await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
    // Label the recall — the vendored unit is among the returned units.
    await runOutcomeRecord(flags({ recall: recall.data?.recallId, helped: true }), ctx());
    await runTrajectoryIndex(flags({ import: shard }), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    const vendoredBlock = index.split("id: trajectory:vendored")[1] ?? "";
    expect(vendoredBlock).toContain("helped: 1");
  });

  test("workshopId resolves from forge.yaml project.name — not a hardcoded literal", async () => {
    await writeFile(join(root, "forge.yaml"), "schema: forge/config@1\nproject: {name: test-shop}\npaths: {}\n");
    await runTrajectoryIndex(flags({}), ctx());
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    expect(index).toContain("workshopId: test-shop");
  });

  test("malformed shard units are skipped — the merge cannot crash on foreign data", async () => {
    const { stringify } = await import("yaml");
    const shard = "docs/.index/trajectory/malformed.yaml";
    await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
    await writeFile(
      join(root, shard),
      stringify({
        schema: "forge/trajectory-shard@1",
        units: [
          { id: "trajectory:no-producer", kind: "trajectory" },
          "a-string-is-not-a-unit",
          null,
        ],
      }) + "\n",
    );
    const res = await runTrajectoryIndex(flags({ import: shard }), ctx());
    expect(res.exitCode).toBe(0);
    // Only the two locally-extracted units survive — all three shard entries skipped.
    expect(res.data?.units).toBe(2);
  });

  test("malformed frontmatter element types cannot crash extraction (R4-1)", async () => {
    await writeFile(join(root, "docs", "sessions", "2026-10-31-12-00-00-dddddd.md"), `---
id: s-weird
verdict: green
taskKind: reconcile
commands: [mission.reconcile, 42]
files: [42, {a: 1}, null]
date: 2026-10-31
---
body
`);
    const res = await runTrajectoryIndex(flags({}), ctx());
    expect(res.exitCode).toBe(0);
    expect(res.data?.admitted).toBe(3);
  });

  test("malformed journal records cannot crash replay — unitsReturned non-array (R3-2)", async () => {
    await runTrajectoryIndex(flags({}), ctx());
    await mkdir(join(root, "docs", ".index", "trajectory"), { recursive: true });
    await writeFile(
      join(root, "docs", ".index", "trajectory", "recalls.jsonl"),
      `{"id":"R-1","unitsReturned":42}\n{"id":"R-2","unitsReturned":"trajectory:s-green"}\n{"id":"R-3","unitsReturned":["trajectory:s-green","trajectory:s-green"]}\n`,
    );
    await writeFile(
      join(root, "docs", ".index", "trajectory", "outcomes.jsonl"),
      `{"recallId":"R-3","helped":true}\n`,
    );
    const res = await runTrajectoryIndex(flags({}), ctx());
    expect(res.exitCode).toBe(0);
    const index = await readFile(join(root, "docs", ".index", "trajectory", "units.yaml"), "utf8");
    // deduped distinct-id count — the string record iterates no chars, R-3 counts once.
    expect(index).toContain("recalled: 1");
    expect(index).toContain("helped: 1");
  });

  test("shard export rewrites artifact-path verdictRefs to portable verdict:<value>", async () => {
    await mkdir(join(root, "missions", "dp7", "evidence"), { recursive: true });
    await writeFile(join(root, "missions", "dp7", "evidence", "validation-report.json"), JSON.stringify({ verdict: "green" }));
    await writeFile(join(root, "docs", "sessions", "2026-10-31-12-00-00-eeeeee.md"), `---
id: s-mission
types: [mission]
commits: [abc123]
files: [missions/dp7/wip.md]
date: 2026-10-31
---
body
`);
    const out = "docs/.index/trajectory/export.yaml";
    await runTrajectoryIndex(flags({ export: out }), ctx());
    const shard = await readFile(join(root, out), "utf8");
    expect(shard).not.toContain("missions/dp7/evidence/validation-report.json");
    expect(shard).toContain("verdictRef: verdict:green");
  });
});
