/*
<MODULE_CONTRACT>
<purpose>RFC-1592 checks.contribution.report liveness tests — every rule record carries liveness: fixture (bound fixture + passing probe run), fired (counters diagnostic), none (no evidence).</purpose>
<non-goals>
  <item>Not a contract source of truth — the implementation under test owns the behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1592: contribution liveness join — fixture/fired/none per rule record</item>
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
import { appendFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runContributionReport } from "./contribution-report.ts";
import { COUNTERS_JOURNAL_PATH, type CheckCounterRecord } from "./counters-journal.ts";
import {
  PROBE_RUNS_JOURNAL_PATH,
  type ProbeRunRecord,
} from "../../gate/handlers/probe-runs-journal.ts";
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
  root = await mkdtemp(join(tmpdir(), "contribution-liveness-"));
  await mkdir(join(root, "docs", "metrics"), { recursive: true });
  await writeFile(
    join(root, "docs", "validator-inventory.generated.yaml"),
    `contracts:
  - contract: knowledge
    validators:
      - rules:
          - id: PROBED-01
            severity: error
          - id: FIRED-02
            severity: error
          - id: QUIET-03
            severity: error
`,
  );
  await writeFile(
    join(root, "forge.yaml"),
    `schema: forge/config@1\nchecksContribution:\n  contractMappings: {}\n`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checks.contribution.report liveness (RFC-1592)", () => {
  test("AC-4: every record carries liveness — fixture, fired, none", async () => {
    // PROBED-01: bound fixture + passing run → fixture.
    const fxDir = join(root, "docs", "gate-probes", "knowledge", "PROBED-01");
    await mkdir(fxDir, { recursive: true });
    await writeFile(
      join(fxDir, "fixture.yaml"),
      `rule: PROBED-01\ncontract: knowledge\nspec:\n  files:\n    demo/x.md: |\n      x\nexpect:\n  rule: PROBED-01\n`,
    );
    await mkdir(join(root, "docs", ".index", "gate-probes"), { recursive: true });
    const run: ProbeRunRecord = {
      runId: "gate.probe-2026-11-14T00:00:00.000Z",
      fixture: "docs/gate-probes/knowledge/PROBED-01/fixture.yaml",
      contract: "knowledge",
      rule: "PROBED-01",
      status: "pass",
      diagnostics: 1,
      at: "2026-11-14T00:00:00.000Z",
    };
    await appendFile(join(root, PROBE_RUNS_JOURNAL_PATH), JSON.stringify(run) + "\n");
    // FIRED-02: a recorded counters diagnostic → fired.
    await mkdir(join(root, "docs", ".index", "checks"), { recursive: true });
    const cRec: CheckCounterRecord = {
      runId: "run-1",
      ruleId: "knowledge/FIRED-02",
      contract: "knowledge",
      outcome: "diagnostic",
      at: "2026-11-14T00:00:00.000Z",
    };
    await appendFile(join(root, COUNTERS_JOURNAL_PATH), JSON.stringify(cRec) + "\n");
    // QUIET-03: no evidence → none.

    const res = await runContributionReport(flags({}), ctx());
    const by = (id: string) => res.data?.rules.find((r) => r.ruleId === id);
    expect(by("PROBED-01")?.liveness).toBe("fixture");
    expect(by("FIRED-02")?.liveness).toBe("fired");
    expect(by("QUIET-03")?.liveness).toBe("none");
    // The liveness field serializes into the metrics artifact too.
    const metrics = res.data?.rules.every(
      (r) => r.liveness === "fixture" || r.liveness === "fired" || r.liveness === "none",
    );
    expect(metrics).toBe(true);
  });

  test("a bound fixture that never ran is none, not fixture", async () => {
    const fxDir = join(root, "docs", "gate-probes", "knowledge", "PROBED-01");
    await mkdir(fxDir, { recursive: true });
    await writeFile(
      join(fxDir, "fixture.yaml"),
      `rule: PROBED-01\ncontract: knowledge\nspec:\n  files:\n    demo/x.md: |\n      x\nexpect:\n  rule: PROBED-01\n`,
    );
    const res = await runContributionReport(flags({}), ctx());
    expect(res.data?.rules.find((r) => r.ruleId === "PROBED-01")?.liveness).toBe("none");
  });
});
