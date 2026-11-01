/*
<MODULE_CONTRACT>
<purpose>RFC-1475 outcome-journal tests — append-only outcomes.jsonl (AC-7), truncated-tail TRAJ-06 tolerance, lazy YAML migration, TRAJ-05 unknown recall id (AC-9).</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTrajectoryIndex } from "./trajectory-index.ts";
import { runTrajectoryRecall } from "./trajectory-recall.ts";
import { runOutcomeRecord } from "./outcome-record.ts";
import { readOutcomesJournal, readRecallsJournal } from "./journal-io.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;
let warns: string[];

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn(m: string) { warns.push(m); }, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown> = {}) {
  return { argv: [], flags: f } as never;
}

const OUTCOMES_JSONL = () => join(root, "docs", ".index", "trajectory", "outcomes.jsonl");
const TRAJ_DIR = () => join(root, "docs", ".index", "trajectory");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trajectory-outcome-"));
  warns = [];
  await mkdir(join(root, "docs", "sessions"), { recursive: true });
  await writeFile(join(root, "docs", "sessions", "2026-10-30-12-00-00-aaaaaa.md"), `---
id: s-green
verdict: green
taskKind: reconcile
commands: [mission.reconcile]
date: 2026-10-30
---
body
`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedIndexAndRecall(): Promise<string> {
  await runTrajectoryIndex(flags({}), ctx());
  const recall = await runTrajectoryRecall(flags({ task: "reconcile" }), ctx());
  return recall.data?.recallId ?? "";
}

describe("outcomes.jsonl append-only journal (RFC-1475 AC-7)", () => {
  test("two outcome.record invocations append two lines — no read-modify-write", async () => {
    const recallId = await seedIndexAndRecall();
    await runOutcomeRecord(flags({ recall: recallId, helped: true }), ctx());
    await runOutcomeRecord(flags({ recall: recallId, hurt: true }), ctx());
    const lines = (await readFile(OUTCOMES_JSONL(), "utf8")).trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).helped).toBe(true);
    expect(JSON.parse(lines[1]!).hurt).toBe(true);
  });

  test("a truncated last line drops only the partial record (TRAJ-06)", async () => {
    const recallId = await seedIndexAndRecall();
    await runOutcomeRecord(flags({ recall: recallId, helped: true }), ctx());
    await appendFile(OUTCOMES_JSONL(), `{"recallId":"${recallId}","helped":tr`);
    const read = await readOutcomesJournal(root);
    expect(read.truncated).toBe(true);
    expect(read.records.length).toBe(1);
    // The handler path surfaces the warning while replay still works.
    warns = [];
    await runTrajectoryIndex(flags({}), ctx());
    expect(warns.some((w) => w.includes("TRAJ-06"))).toBe(true);
  });

  test("lazy migration: outcomes.yaml records append into outcomes.jsonl once", async () => {
    await mkdir(TRAJ_DIR(), { recursive: true });
    await writeFile(
      join(TRAJ_DIR(), "outcomes.yaml"),
      "schema: forge/trajectory-outcomes@1\noutcomes:\n  - {recallId: R-1, helped: true, at: \"2026-10-01T00:00:00Z\"}\n  - {recallId: R-2, hurt: true, at: \"2026-10-02T00:00:00Z\"}\n",
    );
    const first = await readOutcomesJournal(root);
    expect(first.records.length).toBe(2);
    const lines = (await readFile(OUTCOMES_JSONL(), "utf8")).trim().split("\n");
    expect(lines.length).toBe(2);
    // Second read does not re-append (dedupe by {recallId, at}).
    const second = await readOutcomesJournal(root);
    expect(second.records.length).toBe(2);
    expect((await readFile(OUTCOMES_JSONL(), "utf8")).trim().split("\n").length).toBe(2);
    // YAML stays on disk — the read-only source until retired.
    const yamlSrc = await readFile(join(TRAJ_DIR(), "outcomes.yaml"), "utf8");
    expect(yamlSrc).toContain("outcomes:");
  });

  test("unparseable outcomes.yaml warns and skips migration — JSONL unaffected", async () => {
    await mkdir(TRAJ_DIR(), { recursive: true });
    await writeFile(join(TRAJ_DIR(), "outcomes.yaml"), "outcomes: [unclosed\n  - : :");
    const read = await readOutcomesJournal(root);
    expect(read.records.length).toBe(0);
    expect(read.warnings.some((w) => w.includes("unparseable"))).toBe(true);
  });
});

describe("unknown recall id (RFC-1475 AC-9)", () => {
  test("a corrupt units index → TRAJ-02, never a raw exception", async () => {
    const recallId = await seedIndexAndRecall();
    await writeFile(join(TRAJ_DIR(), "units.yaml"), "units: [unclosed\n  - : :");
    const res = await runOutcomeRecord(flags({ recall: recallId, helped: true }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-02");
  });

  test("TRAJ-05 — distinct from the index-staleness signal", async () => {
    await seedIndexAndRecall();
    const res = await runOutcomeRecord(flags({ recall: "R-9999-99-ffff", helped: true }), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("TRAJ-05");
    expect(res.data?.diagnostics?.[0]?.ruleId).toBe("TRAJ-05");
  });
});

describe("recalls.jsonl shared reader", () => {
  test("outcome.record resolves a recall journaled via recalls.jsonl", async () => {
    const recallId = await seedIndexAndRecall();
    const res = await runOutcomeRecord(flags({ recall: recallId, helped: true }), ctx());
    expect(res.exitCode).toBe(0);
    expect(res.data?.unitUpdates).toBeGreaterThan(0);
    const recalls = await readRecallsJournal(root);
    expect(recalls.records.some((r) => r.id === recallId)).toBe(true);
  });
});

describe("journal hardening edges (review round-1)", () => {
  test("a second label for the same recallId does not double-count `recalled`", async () => {
    const recallId = await seedIndexAndRecall();
    await runOutcomeRecord(flags({ recall: recallId, helped: true }), ctx());
    await runOutcomeRecord(flags({ recall: recallId, hurt: true }), ctx());
    const index = await readFile(join(TRAJ_DIR(), "units.yaml"), "utf8");
    // replay semantics — one `recalled` per recall record, not per label.
    expect(index).toContain("recalled: 1");
    expect(index).toContain("helped: 1");
    expect(index).toContain("hurt: 1");
  });

  test("wrong-shape YAML journal warns and migrates nothing", async () => {
    await mkdir(TRAJ_DIR(), { recursive: true });
    await writeFile(join(TRAJ_DIR(), "outcomes.yaml"), "- a\n- top-level\n- list\n");
    const read = await readOutcomesJournal(root);
    expect(read.records.length).toBe(0);
    expect(read.warnings.some((w) => w.includes("not a outcomes journal"))).toBe(true);
    const read2 = await readOutcomesJournal(root);
    expect(read2.records.length).toBe(0);
  });

  test("non-object JSONL lines are malformed records — dropped like corrupt lines", async () => {
    await mkdir(TRAJ_DIR(), { recursive: true });
    await writeFile(OUTCOMES_JSONL(), `{"recallId":"R-1","helped":true}\n42\nnull\n{"recallId":"R-2","hurt":true}\n`);
    const read = await readOutcomesJournal(root);
    expect(read.records.length).toBe(2);
    // The last line is a valid object — mid-file non-objects are skipped, not truncation.
    expect(read.truncated).toBe(false);
  });
});
