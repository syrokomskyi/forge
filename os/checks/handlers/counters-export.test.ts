/*
<MODULE_CONTRACT>
<purpose>RFC-1474 checks.counters.export tests — journal projection into the
deterministic docs/metrics/check-counters.generated.yaml artifact (per-rule
evaluated/diagnostic/lastRunId/lastAt), generatedAt derived from the max
journal `at` (never wall-clock), --check staleness gate (COUNT-03).</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-os-checks</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCountersExport } from "./counters-export.ts";
import { COUNTERS_JOURNAL_PATH, type CheckCounterRecord } from "./counters-journal.ts";
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

const rec = (over: Partial<CheckCounterRecord> = {}): CheckCounterRecord => ({
  runId: "run-a",
  ruleId: "gate/GATE-CMP-01",
  contract: "gate",
  outcome: "pass",
  at: "2026-10-31T20:00:00.000Z",
  ...over,
});

async function seedJournal(records: CheckCounterRecord[]) {
  await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
  await appendFile(
    join(root, COUNTERS_JOURNAL_PATH),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "counters-export-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checks.counters.export", () => {
  test("AC-2: projects per-rule totals into the deterministic artifact", async () => {
    await seedJournal([
      rec({ outcome: "pass" }),
      rec({ outcome: "diagnostic", runId: "run-b", at: "2026-10-31T21:00:00.000Z" }),
      rec({ ruleId: "gate/GATE-CMP-02", outcome: "skipped", runId: "run-b", at: "2026-10-31T21:00:00.000Z" }),
    ]);
    const result = await runCountersExport(flags(), ctx());
    expect(result.exitCode).toBe(0);
    const artifact = await readFileSync();
    expect(artifact.rules.find((r) => r.ruleId === "gate/GATE-CMP-01")).toMatchObject({
      evaluated: 2,
      diagnostic: 1,
      lastRunId: "run-b",
      lastAt: "2026-10-31T21:00:00.000Z",
    });
    // skipped does not count as evaluated.
    expect(artifact.rules.find((r) => r.ruleId === "gate/GATE-CMP-02")).toMatchObject({
      evaluated: 0,
      diagnostic: 0,
    });
    expect(artifact.runCount).toBe(2);
  });

  async function readFileSync() {
    const { parse } = await import("yaml");
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(join(root, "docs", "metrics", "check-counters.generated.yaml"), "utf8");
    return parse(src) as {
      generatedAt: string;
      runCount: number;
      rules: { ruleId: string; evaluated: number; diagnostic: number; lastRunId: string; lastAt: string }[];
    };
  }

  test("AC-10: generatedAt derives from the max journal at, never wall-clock", async () => {
    await seedJournal([
      rec({ at: "2026-10-31T20:00:00.000Z" }),
      rec({ at: "2026-10-29T10:00:00.000Z", ruleId: "gate/G-2" }),
      rec({ at: "2026-10-31T23:59:59.000Z", ruleId: "gate/G-3" }),
    ]);
    const result = await runCountersExport(flags(), ctx());
    expect(result.exitCode).toBe(0);
    const artifact = await readFileSync();
    expect(artifact.generatedAt).toBe("2026-10-31T23:59:59.000Z");
    expect(artifact.generatedAt).not.toMatch(/^2026-1[12]/); // not the current clock
  });

  test("empty journal exports an honest empty artifact", async () => {
    const result = await runCountersExport(flags(), ctx());
    expect(result.exitCode).toBe(0);
    const artifact = await readFileSync();
    expect(artifact.rules).toEqual([]);
    expect(artifact.generatedAt).toBe("no-data");
    expect(artifact.runCount).toBe(0);
  });

  test("does not crash on a truncated journal tail (AC-2 tolerance)", async () => {
    await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
    await appendFile(
      join(root, COUNTERS_JOURNAL_PATH),
      JSON.stringify(rec()) + "\n" + `{"runId":"x","ruleId":"gat`,
    );
    const result = await runCountersExport(flags(), ctx());
    expect(result.exitCode).toBe(0);
    const artifact = await readFileSync();
    expect(artifact.rules).toHaveLength(1);
  });

  test("COUNT-03: --check exits 1 when the committed artifact is stale", async () => {
    await seedJournal([rec()]);
    await mkdir(join(root, "docs", "metrics"), { recursive: true });
    await writeFile(join(root, "docs", "metrics", "check-counters.generated.yaml"), "stale: true\n");
    const result = await runCountersExport(flags({ check: true }), ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics?.some((d) => d.ruleId === "COUNT-03")).toBe(true);
  });

  test("--check exits 0 when the artifact is fresh", async () => {
    await seedJournal([rec()]);
    await runCountersExport(flags(), ctx()); // write fresh artifact
    const result = await runCountersExport(flags({ check: true }), ctx());
    expect(result.exitCode).toBe(0);
  });

  test("producer-own tail records do not pin --check red (self-tail tolerance)", async () => {
    await seedJournal([rec()]);
    await runCountersExport(flags(), ctx());
    // Simulate the exporter's own post-write journal tail — structurally
    // unreachable by the committed artifact, so the check stays green.
    await appendFile(
      join(root, COUNTERS_JOURNAL_PATH),
      JSON.stringify(rec({ ruleId: "checks/COUNT-03", contract: "checks", runId: "checks.counters.export-999-zz", at: "2026-10-31T22:00:00.000Z" })) + "\n",
    );
    const result = await runCountersExport(flags({ check: true }), ctx());
    expect(result.exitCode).toBe(0);
  });

  test("non-producer journal growth still flags COUNT-03", async () => {
    await seedJournal([rec()]);
    await runCountersExport(flags(), ctx());
    await appendFile(
      join(root, COUNTERS_JOURNAL_PATH),
      JSON.stringify(rec({ ruleId: "gate/GATE-CMP-02", runId: "other.validator-1-x", at: "2026-10-31T22:00:00.000Z" })) + "\n",
    );
    const result = await runCountersExport(flags({ check: true }), ctx());
    expect(result.exitCode).toBe(1);
    expect(result.data!.diagnostics!.some((d) => d.ruleId === "COUNT-03")).toBe(true);
  });

  test("--out overrides the artifact path", async () => {
    await seedJournal([rec()]);
    const result = await runCountersExport(flags({ out: "docs/metrics/custom-counters.yaml" }), ctx());
    expect(result.exitCode).toBe(0);
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(join(root, "docs", "metrics", "custom-counters.yaml"), "utf8");
    expect(src).toContain("forge/check-counters@1");
  });
});
