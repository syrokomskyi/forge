/*
<MODULE_CONTRACT>
<purpose>RFC-1592 gate.probe.catalog ratchet tests — PROBE-06 (unprobed rule outside the shrink-only baseline), PROBE-07 (stale baseline entry), PROBE-08 (--write-baseline refuses growth), PROBE-09 (expired/undeclared provisional surfaces).</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1592: ratchet tests — baseline creation/subset rewrite/refusal, liveness-aware stale detection, warnOnly/provisionalUntil scan</item>
  <item>RFC-1592: probe-or-retire ratchet for blocking check rules

Every error-severity check rule now needs liveness evidence — a bound
gate-probe fixture that has actually run — or an explicit entry in the
shrink-only unprobed baseline, enforced by gate.probe.catalog --check
(PROBE-06/07) and wired into the worktree gate as probe-ratchet.

- probe-runs journal (docs/.index/gate-probes/runs.jsonl) records each
  gate.probe fixture execution; shared liveness.ts joins fixtures x
  journal for catalog + contribution report (liveness: none|fixture|fired)
- gate.probe.catalog --check/--write-baseline: PROBE-06 unprobed error
  rule, PROBE-07 stale baseline entry, PROBE-08 baseline growth refusal
  (shrink-only, no file modification), PROBE-09 expired/undeclared
  warnOnly provisional step
- checks.contribution.report adds liveness to every rule record
- KernelPipelineStep/RuleDescriptor gain provisionalUntil; the two
  warnOnly pipeline steps carry future dates
- worktree gate adds probe-ratchet step; gate-domains + forge pre-lock
  DELTA_STEP_SPECS mirror updated
- build-verification policy states blocking rules are probed or retired;
  fo-session-retro preserves probe/retire evidence for escape frictions
- baseline adopted at 1678 entries (forge/unprobed-baseline@1)</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGateProbeCatalog, UNPROBED_BASELINE_REL } from "./gate-probe-catalog.ts";
import {
  COUNTERS_JOURNAL_PATH,
  type CheckCounterRecord,
} from "../../checks/handlers/counters-journal.ts";
import { PROBE_RUNS_JOURNAL_PATH, type ProbeRunRecord } from "./probe-runs-journal.ts";
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

async function seedInventory(rules: { id: string; severity?: string }[]) {
  await mkdir(join(root, "docs"), { recursive: true });
  const body = rules
    .map((r) => `          - id: ${r.id}\n            severity: ${r.severity ?? "error"}`)
    .join("\n");
  await writeFile(
    join(root, "docs", "validator-inventory.generated.yaml"),
    `contracts:\n  - contract: knowledge\n    validators:\n      - rules:\n${body}\n`,
  );
}

async function seedCounters(records: CheckCounterRecord[]) {
  await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
  await appendFile(
    join(root, COUNTERS_JOURNAL_PATH),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

const cRec = (ruleId: string, outcome: CheckCounterRecord["outcome"]): CheckCounterRecord => ({
  runId: "run-1",
  ruleId,
  contract: "knowledge",
  outcome,
  at: "2026-11-14T00:00:00.000Z",
});

async function seedProbeRuns(records: ProbeRunRecord[]) {
  await mkdir(join(root, "docs", ".index", "gate-probes"), { recursive: true });
  await appendFile(
    join(root, PROBE_RUNS_JOURNAL_PATH),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

const pRec = (rule: string, status: ProbeRunRecord["status"]): ProbeRunRecord => ({
  runId: "gate.probe-2026-11-14T00:00:00.000Z",
  fixture: `docs/gate-probes/knowledge/${rule}/fixture.yaml`,
  contract: "knowledge",
  rule,
  status,
  diagnostics: status === "pass" ? 1 : 0,
  at: "2026-11-14T00:00:00.000Z",
});

async function seedFixture(rule: string) {
  const dir = join(root, "docs", "gate-probes", "knowledge", rule);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "fixture.yaml"),
    `rule: ${rule}\ncontract: knowledge\nspec:\n  files:\n    demo/broken.md: |\n      x\nexpect:\n  rule: ${rule}\n  minDiagnostics: 1\n`,
  );
}

async function writeBaseline(rules: string[]) {
  await mkdir(join(root, "docs", "gate-probes"), { recursive: true });
  await writeFile(
    join(root, UNPROBED_BASELINE_REL),
    `schema: forge/unprobed-baseline@1\ngeneratedBy: gate.probe.catalog\nrules:\n${rules.map((r) => `  - ${r}`).join("\n")}${rules.length > 0 ? "\n" : ""}`,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "probe-ratchet-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gate.probe.catalog ratchet (RFC-1592)", () => {
  test("AC-1: unprobed error rule with no baseline → PROBE-06 names it, exit 1", async () => {
    await seedInventory([{ id: "UNPROBED-01" }, { id: "WARN-01", severity: "warning" }]);
    const res = await runGateProbeCatalog(flags({ check: true }), ctx());
    expect(res.exitCode).toBe(1);
    const p6 = res.data?.diagnostics?.filter((d) => d.ruleId === "PROBE-06") ?? [];
    expect(p6.length).toBe(1);
    expect(p6[0]?.message).toContain("UNPROBED-01");
    expect(p6[0]?.fixHint).toContain("--write-baseline");
    // warning-severity rules are outside the ratchet.
    expect(p6.some((d) => d.message.includes("WARN-01"))).toBe(false);
    expect(res.data?.ratchet?.newUnprobed).toEqual(["UNPROBED-01"]);
  });

  test("AC-1: baseline present — only rules outside it flag PROBE-06", async () => {
    await seedInventory([{ id: "OLD-01" }, { id: "NEW-02" }]);
    await writeBaseline(["OLD-01"]);
    const res = await runGateProbeCatalog(flags({ check: true }), ctx());
    expect(res.exitCode).toBe(1);
    const p6 = res.data?.diagnostics?.filter((d) => d.ruleId === "PROBE-06") ?? [];
    expect(p6.map((d) => d.message).join()).toContain("NEW-02");
    expect(p6.map((d) => d.message).join()).not.toContain("OLD-01");
  });

  test("AC-2: baseline entry now fired/probed → PROBE-07; dead entry → PROBE-07", async () => {
    await seedInventory([{ id: "FIRED-01" }, { id: "FIXED-02" }, { id: "STILL-03" }]);
    await seedCounters([cRec("knowledge/FIRED-01", "diagnostic")]);
    await seedFixture("FIXED-02");
    await seedProbeRuns([pRec("FIXED-02", "pass")]);
    await writeBaseline(["FIRED-01", "FIXED-02", "STILL-03", "DELETED-99"]);
    const res = await runGateProbeCatalog(flags({ check: true }), ctx());
    expect(res.exitCode).toBe(1);
    const p7 = res.data?.diagnostics?.filter((d) => d.ruleId === "PROBE-07") ?? [];
    const msg = p7.map((d) => d.message).join("\n");
    expect(msg).toContain("FIRED-01");
    expect(msg).toContain("FIXED-02");
    expect(msg).toContain("DELETED-99");
    expect(msg).not.toContain("STILL-03");
    expect(res.data?.ratchet?.staleBaseline).toEqual(
      expect.arrayContaining(["FIRED-01", "FIXED-02", "DELETED-99"]),
    );
    // STILL-03 stays unprobed but baselined → no PROBE-06.
    expect(res.data?.diagnostics?.some((d) => d.ruleId === "PROBE-06")).toBe(false);
  });

  test("AC-3: --write-baseline refusing growth leaves the file unchanged", async () => {
    await seedInventory([{ id: "OLD-01" }, { id: "NEW-02" }]);
    await writeBaseline(["OLD-01"]);
    const before = await readFile(join(root, UNPROBED_BASELINE_REL), "utf8");
    const res = await runGateProbeCatalog(flags({ "write-baseline": true }), ctx());
    expect(res.exitCode).toBe(1);
    const p8 = res.data?.diagnostics?.filter((d) => d.ruleId === "PROBE-08") ?? [];
    expect(p8.length).toBe(1);
    expect(p8[0]?.message).toContain("NEW-02");
    expect(await readFile(join(root, UNPROBED_BASELINE_REL), "utf8")).toBe(before);
  });

  test("--write-baseline: creates absent baseline; subset rewrite is allowed", async () => {
    await seedInventory([{ id: "OLD-01" }, { id: "FIRED-02" }]);
    // Creation: no baseline → writes the current unprobed set.
    const created = await runGateProbeCatalog(flags({ "write-baseline": true }), ctx());
    expect(created.exitCode).toBe(0);
    const first = await readFile(join(root, UNPROBED_BASELINE_REL), "utf8");
    expect(first).toContain("forge/unprobed-baseline@1");
    expect(first).toContain("OLD-01");
    expect(first).toContain("FIRED-02");
    // A firing shrinks the unprobed set → subset rewrite removes it.
    await seedCounters([cRec("knowledge/FIRED-02", "diagnostic")]);
    const shrunk = await runGateProbeCatalog(flags({ "write-baseline": true }), ctx());
    expect(shrunk.exitCode).toBe(0);
    const second = await readFile(join(root, UNPROBED_BASELINE_REL), "utf8");
    expect(second).toContain("OLD-01");
    expect(second).not.toContain("FIRED-02");
  });

  test("AC-7: warnOnly step without provisionalUntil → PROBE-09 names it", async () => {
    await seedInventory([]);
    await writeBaseline([]);
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    await writeFile(
      join(root, "packages", "demo", "pipeline.ts"),
      `export const STEPS = [\n  { command: "demo.check", warnOnly: true },\n];\n`,
    );
    const res = await runGateProbeCatalog(flags({ check: true }), ctx());
    expect(res.exitCode).toBe(1);
    const p9 = res.data?.diagnostics?.filter((d) => d.ruleId === "PROBE-09") ?? [];
    expect(p9.length).toBe(1);
    expect(p9[0]?.message).toContain("demo.check");
    expect(p9[0]?.message).toContain("provisionalUntil");
  });

  test("AC-7: expired provisionalUntil → PROBE-09; future date → clean", async () => {
    await seedInventory([]);
    await writeBaseline([]);
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    const pipe = join(root, "packages", "demo", "pipeline.ts");
    await writeFile(
      pipe,
      `export const STEPS = [\n  { command: "demo.check", warnOnly: true, provisionalUntil: "2020-01-01" },\n];\n`,
    );
    const expired = await runGateProbeCatalog(flags({ check: true }), ctx());
    expect(expired.exitCode).toBe(1);
    expect(
      (expired.data?.diagnostics ?? []).some(
        (d) => d.ruleId === "PROBE-09" && d.message.includes("demo.check"),
      ),
    ).toBe(true);
    await writeFile(
      pipe,
      `export const STEPS = [\n  { command: "demo.check", warnOnly: true, provisionalUntil: "2999-01-01" },\n];\n`,
    );
    const fresh = await runGateProbeCatalog(flags({ check: true }), ctx());
    expect(fresh.exitCode).toBe(0);
  });
});
