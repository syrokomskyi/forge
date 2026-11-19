/*
<MODULE_CONTRACT>
<purpose>RFC-1592: shared rule-liveness projection — the fixture-inventory
walk (docs/gate-probes/<contract>/<rule>/fixture.yaml) plus the RuleLiveness
join: "fixture" when a bound fixture's last probe run fired, "fired" when the
counters journal recorded an emission, "none" otherwise. Consumed by
gate.probe.catalog (ratchet) and checks.contribution.report (liveness field).</purpose>
<non-goals>
  <item>Probe execution and baseline persistence live in their own modules —
  this file only reads declared inventories and journal projections.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>A fixture whose last run failed or never ran is not liveness evidence — state stays "none" until a pass.</item>
  <item>Coverage "none" makes "fired" unreachable; partial trusts a recorded emission — absence stays "none" without fixture proof.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1592: shared liveness projection — fixture walk + RuleLiveness join for catalog and contribution consumers</item>
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

import path from "node:path";
import { parse as yamlParse } from "yaml";
import type { WorkspaceIO } from "../../../src/types.ts";
import type { ProbeRunStatus } from "./probe-runs-journal.ts";

export type RuleLiveness = "fixture" | "fired" | "none";

export interface FixtureBinding {
  /** Workspace-relative fixture.yaml path. */
  path: string;
  /** Contract directory the fixture sits under. */
  contract: string;
  /** The rule the fixture binds. */
  rule: string;
  derivedFrom?: string;
}

/**
 * Walks docs/gate-probes/<contract>/<rule>/fixture.yaml — the same inventory
 * both liveness consumers join on.
 */
export async function collectFixtureBindings(
  root: string,
  io: WorkspaceIO,
): Promise<FixtureBinding[]> {
  const out: FixtureBinding[] = [];
  const base = path.join(root, "docs", "gate-probes");
  const contracts = await io
    .readdir(base)
    .catch(() => [] as { name: string; isDirectory: boolean }[]);
  for (const c of contracts) {
    if (!c.isDirectory || c.name.startsWith("_")) continue;
    const cdir = path.join(base, c.name);
    for (const r of await io
      .readdir(cdir)
      .catch(() => [] as { name: string; isDirectory: boolean }[])) {
      if (!r.isDirectory) continue;
      const fp = path.join(cdir, r.name, "fixture.yaml");
      const src = await io.readFile(fp).catch(() => null);
      if (src === null) continue;
      const parsed = yamlParse(src) as { rule?: string; derivedFrom?: string } | null;
      if (parsed?.rule) {
        out.push({
          path: path.relative(root, fp).split(path.sep).join("/"),
          contract: c.name,
          rule: parsed.rule,
          derivedFrom: parsed.derivedFrom,
        });
      }
    }
  }
  return out;
}

/**
 * The RFC-1592 liveness state for one rule:
 * - `fixture` — bound to a probe fixture whose LAST recorded run passed
 * - `fired` — the counters journal recorded at least one emission
 * - `none` — no liveness evidence
 */
export function ruleLiveness(opts: {
  bound: boolean;
  lastRun: ProbeRunStatus | undefined;
  emitted: boolean;
  coverage: "none" | "partial" | "complete";
}): RuleLiveness {
  if (opts.bound && opts.lastRun === "pass") return "fixture";
  if (opts.emitted && opts.coverage !== "none") return "fired";
  return "none";
}
