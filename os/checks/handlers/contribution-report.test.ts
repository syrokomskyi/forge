/*
<MODULE_CONTRACT>
<purpose>RFC-1473 checks.contribution.report tests — per-rule contribution records (emitted/uniqueEmitted/zeroStreak/escapeCount/verdict), silent/redundant/guard classification, metrics artifact written.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runContributionReport } from "./contribution-report.ts";
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
  root = await mkdtemp(join(tmpdir(), "contribution-"));
  await mkdir(join(root, "docs", "sessions", "audit"), { recursive: true });
  await mkdir(join(root, "docs", "metrics"), { recursive: true });
  await writeFile(
    join(root, "docs", "validator-inventory.generated.yaml"),
    `contracts:
  - contract: knowledge
    validators:
      - rules:
          - id: SKILL-19
            severity: error
          - id: KAUTHZ-01
            severity: error
          - id: NEVER-FIRE-99
            severity: error
`,
  );
  await writeFile(join(root, "docs", "frictions.yaml"), `- id: F-0099
  category: tooling
  recurrences: 2
`);
  await writeFile(join(root, "forge.yaml"), `schema: forge/config@1
checksContribution:
  contractMappings:
    tooling: knowledge
  guardRules: [PROBE-01]
`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

import { appendFile } from "node:fs/promises";
import { COUNTERS_JOURNAL_PATH, type CheckCounterRecord } from "./counters-journal.ts";

async function seedJournal(records: CheckCounterRecord[]) {
  await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
  await appendFile(
    join(root, COUNTERS_JOURNAL_PATH),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

const cRec = (over: Partial<CheckCounterRecord> = {}): CheckCounterRecord => ({
  runId: "run-1",
  ruleId: "knowledge/SKILL-19",
  contract: "knowledge",
  outcome: "diagnostic",
  at: "2026-10-31T20:00:00.000Z",
  ...over,
});

describe("checks.contribution.report (RFC-1473)", () => {
  test("per-rule records: fired rules earn, never-fired are silent, escapes counted", async () => {
    // Seed a firing history: SKILL-19 fires once (counters = primary source),
    // KAUTHZ-01 never, NEVER-FIRE-99 never; the sidecar carries the signature.
    await seedJournal([cRec()]);
    await writeFile(
      join(root, "docs", "sessions", "audit", "s1.audit.yaml"),
      `sessionId: s1
findings:
  - ruleId: SKILL-19
    signature: "sig-abc"
`,
    );
    const res = await runContributionReport(flags({}), ctx());
    const skill = res.data?.rules.find((r) => r.ruleId === "SKILL-19");
    const never = res.data?.rules.find((r) => r.ruleId === "NEVER-FIRE-99");
    expect(skill?.emitted).toBe(1);
    expect(skill?.evaluated).toBe(1);
    expect(skill?.lastFiredAt).toBe("2026-10-31T20:00:00.000Z");
    expect(skill?.verdict).toBe("earning");
    expect(never?.emitted).toBe(0);
    expect(never?.verdict).toBe("silent");
    expect(never?.escapeCount).toBe(1);
    expect(res.data?.variantCandidates.some((v) => v.rule === "SKILL-19")).toBe(true);
  });

  test("metrics artifact written; --check diffs vs committed for staleness", async () => {
    await runContributionReport(flags({}), ctx());
    const metrics = await readFile(join(root, "docs", "metrics", "check-contribution.generated.yaml"), "utf8").catch(() => "");
    expect(metrics).toContain("check-contribution@1");
    const fresh = await runContributionReport(flags({ check: true }), ctx());
    expect(fresh.exitCode).toBe(0);
    // A sidecar addition changes the computed output → --check flags stale.
    await writeFile(
      join(root, "docs", "sessions", "audit", "s2.audit.yaml"),
      `sessionId: s2\nfindings:\n  - ruleId: SKILL-19\n    signature: "sig-new"\nauditedAt: "2026-11-01"\n`,
    );
    const stale = await runContributionReport(flags({ check: true }), ctx());
    expect(stale.exitCode).toBe(1);
    expect(stale.summary).toContain("CONTRIB-02");
  });

  test("CONTRIB-01: missing inventory blocks, not a silent empty report", async () => {
    await rm(join(root, "docs", "validator-inventory.generated.yaml"));
    const res = await runContributionReport(flags({}), ctx());
    expect(res.exitCode).toBe(1);
    expect(res.summary).toContain("CONTRIB-01");
  });
});

describe("checks.contribution.report — counters journal firing source (RFC-1474)", () => {
  test("AC-5/AC-6: counters join drives emitted/zeroStreak/lastFiredAt; coverage complete at >= window runs", async () => {
    // 3 rules, 3 window runs (window default 20 → --window 3 makes it complete).
    // SKILL-19 diagnoses in run-1 only → zeroStreak counts runs since.
    await seedJournal([
      cRec({ runId: "run-1", at: "2026-10-31T20:00:00.000Z" }),
      cRec({ ruleId: "knowledge/KAUTHZ-01", outcome: "pass", runId: "run-1", at: "2026-10-31T20:00:00.000Z" }),
      cRec({ outcome: "pass", runId: "run-2", at: "2026-10-31T21:00:00.000Z" }),
      cRec({ ruleId: "knowledge/KAUTHZ-01", outcome: "pass", runId: "run-2", at: "2026-10-31T21:00:00.000Z" }),
      cRec({ outcome: "pass", runId: "run-3", at: "2026-10-31T22:00:00.000Z" }),
      cRec({ ruleId: "knowledge/KAUTHZ-01", outcome: "pass", runId: "run-3", at: "2026-10-31T22:00:00.000Z" }),
    ]);
    const res = await runContributionReport(flags({ window: "3" }), ctx());
    expect(res.exitCode).toBe(0);
    expect(res.data?.window.coverage).toBe("complete");
    expect(res.data?.window.runs).toBe(3);
    const skill = res.data?.rules.find((r) => r.ruleId === "SKILL-19");
    expect(skill?.emitted).toBe(1);
    expect(skill?.evaluated).toBe(3);
    expect(skill?.zeroStreak).toBe(2); // run-2, run-3 since the run-1 diagnostic
    expect(skill?.lastFiredAt).toBe("2026-10-31T20:00:00.000Z");
    expect(skill?.verdict).toBe("earning");
    const kauthz = res.data?.rules.find((r) => r.ruleId === "KAUTHZ-01");
    expect(kauthz?.emitted).toBe(0);
    expect(kauthz?.evaluated).toBe(3);
    expect(kauthz?.zeroStreak).toBe(3);
    expect(kauthz?.verdict).toBe("silent");
    expect(res.data?.window.effective).toBe(2); // both rules evaluated + in inventory
  });

  test("coverage: partial when the journal covers fewer runs than the window", async () => {
    await seedJournal([cRec()]);
    const res = await runContributionReport(flags({}), ctx()); // window 20, 1 run
    expect(res.data?.window.coverage).toBe("partial");
    expect(res.data?.window.runs).toBe(1);
    expect(res.data?.diagnostics ?? []).toHaveLength(0);
  });

  test("AC-7: absent journal → coverage none + CONTRIB-03 + honest zeros", async () => {
    const res = await runContributionReport(flags({}), ctx());
    expect(res.exitCode).toBe(0);
    expect(res.data?.window.coverage).toBe("none");
    const contrib03 = res.data?.diagnostics?.find((d) => d.ruleId === "CONTRIB-03");
    expect(contrib03).toBeDefined();
    expect(contrib03?.severity).toBe("warning");
    const skill = res.data?.rules.find((r) => r.ruleId === "SKILL-19");
    expect(skill?.emitted).toBe(0);
    expect(skill?.evaluated).toBe(0);
    expect(skill?.zeroStreak).toBe(0);
    expect(skill?.verdict).toBe("silent");
  });

  test("skipped records never count as evaluated", async () => {
    await seedJournal([
      cRec({ outcome: "skipped", runId: "run-1" }),
      cRec({ outcome: "pass", runId: "run-2", at: "2026-10-31T21:00:00.000Z" }),
    ]);
    const res = await runContributionReport(flags({ window: "2" }), ctx());
    const skill = res.data?.rules.find((r) => r.ruleId === "SKILL-19");
    expect(skill?.evaluated).toBe(1); // only run-2's pass
    expect(skill?.emitted).toBe(0);
  });

  test("window trims to the last N runs by first at", async () => {
    await seedJournal([
      cRec({ runId: "old-run", at: "2026-10-01T00:00:00.000Z" }),
      cRec({ outcome: "diagnostic", runId: "new-run", at: "2026-10-31T20:00:00.000Z" }),
    ]);
    const res = await runContributionReport(flags({ window: "1" }), ctx());
    expect(res.data?.window.runs).toBe(1);
    const skill = res.data?.rules.find((r) => r.ruleId === "SKILL-19");
    // Only the newest run is in the window.
    expect(skill?.emitted).toBe(1);
    expect(skill?.evaluated).toBe(1);
    expect(skill?.lastFiredAt).toBe("2026-10-31T20:00:00.000Z");
  });

  test("CONTRIB-02 --check tolerates the report's own journal tail, gates real growth", async () => {
    await seedJournal([cRec()]);
    await runContributionReport(flags({}), ctx()); // committed artifact
    // Self-tail (own producer family) — unreachable by the artifact: fresh.
    await appendFile(
      join(root, COUNTERS_JOURNAL_PATH),
      JSON.stringify(cRec({ ruleId: "checks/CONTRIB-03", contract: "checks", runId: "checks.contribution.report-9-z", outcome: "pass", at: "2026-10-31T21:00:00.000Z" })) + "\n",
    );
    const fresh = await runContributionReport(flags({ check: true }), ctx());
    expect(fresh.exitCode).toBe(0);
    // Foreign growth — the journal genuinely moved: stale.
    await appendFile(
      join(root, COUNTERS_JOURNAL_PATH),
      JSON.stringify(cRec({ runId: "other.validator-1-x", at: "2026-10-31T22:00:00.000Z" })) + "\n",
    );
    const stale = await runContributionReport(flags({ check: true }), ctx());
    expect(stale.exitCode).toBe(1);
    expect(stale.summary).toContain("CONTRIB-02");
  });
});
