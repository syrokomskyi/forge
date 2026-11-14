/*
<MODULE_CONTRACT>
<purpose>Register forgeChecksModule — checks.contribution.report (RFC-1473) per-rule marginal-contribution read-model for gate-catalog maintenance, plus the RFC-1474 counters surface: checks.counters.export (deterministic per-rule totals projection) and checks.counters.validate (journal integrity gate vs the validator inventory).</purpose>
<non-goals>
  <item>TODO(compass): record the boundary this file must not take on.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1474: check-execution counters — apply review findings (F-1..F-9)</item>
  <item>RFC-1474: check-execution counters — apply re-review findings (structural skip flag, violations extraction, Date.parse ordering, DEV-5/6)</item>
  <item>RFC-1485: sweep compass headers — forge-os-checks</item>
  <item>RFC-1590: store append-only shared ledgers as one file per record</item>
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
  <history>RFC-1473, RFC-1474</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runContributionReport } from "./handlers/contribution-report.ts";
import { runCountersExport } from "./handlers/counters-export.ts";
import { runCountersValidate } from "./handlers/counters-validate.ts";
import { FRICTION_DIR, LEGACY_FRICTION_FILE } from "../friction/store.ts";

export const forgeChecksModule: ForgeModule = {
  name: "forge-checks",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "checks.contribution.report",
      coverage: "operator" as const,
      contract: "checks",
      mutatesState: true,
      rules: [
        { id: "CONTRIB-01", severity: "error" },
        { id: "CONTRIB-02", severity: "warning" },
        { id: "CONTRIB-03", severity: "warning" },
      ],
      description:
        "RFC-1473/1474: per-rule marginal-contribution read-model — the counters journal is the primary firing source (emitted/zeroStreak/lastFiredAt), session sidecars stay secondary diagnostic history (uniqueEmitted/firedOn); earning|silent|redundant|guard verdicts + variantCandidates. Writes docs/metrics/check-contribution.generated.yaml (coverage none|partial|complete). Flags: --window, --contract, --check.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        window: { kind: "string", description: "Reporting window in run count (default 20)." },
        contract: { kind: "string", description: "Restrict to one contract." },
        check: { kind: "boolean", description: "Read-only — no metrics write." },
      },
      reads: [
        "docs/validator-inventory.generated.yaml",
        "docs/.index/checks/counters.jsonl",
        "docs/.index/gate-probes/runs.jsonl",
        "docs/gate-probes/**",
        "docs/sessions/audit/*.audit.yaml",
        `${FRICTION_DIR}/**`,
        LEGACY_FRICTION_FILE,
      ],
      writes: ["docs/metrics/check-contribution.generated.yaml"],
      generates: [
        { path: "docs/metrics/check-contribution.generated.yaml", phase: "on-demand" as const },
      ],
      execute: runContributionReport,
    },
    {
      name: "checks.counters.export",
      coverage: "operator" as const,
      contract: "checks",
      mutatesState: true,
      rules: [{ id: "COUNT-03", severity: "warning" }],
      description:
        "RFC-1474: project docs/.index/checks/counters.jsonl into the deterministic committed artifact docs/metrics/check-counters.generated.yaml (per-rule evaluated/diagnostic/lastRunId/lastAt; generatedAt = max journal at). --check diffs vs the committed file (COUNT-03). Flags: --out, --check.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        out: {
          kind: "string",
          description:
            "Artifact path override (default docs/metrics/check-counters.generated.yaml).",
        },
        check: {
          kind: "boolean",
          description:
            "Read-only — diff the computed artifact against the committed file (COUNT-03).",
        },
      },
      reads: ["docs/.index/checks/counters.jsonl"],
      writes: ["docs/metrics/check-counters.generated.yaml"],
      generates: [
        { path: "docs/metrics/check-counters.generated.yaml", phase: "on-demand" as const },
      ],
      execute: runCountersExport,
    },
    {
      name: "checks.counters.validate",
      coverage: "operator" as const,
      contract: "checks",
      mutatesState: false,
      rules: [
        { id: "COUNT-01", severity: "error" },
        { id: "COUNT-02", severity: "error" },
      ],
      description:
        "RFC-1474: counters-journal integrity gate — COUNT-01 (record ruleId resolves to no inventory rule; malformed middle lines) + COUNT-02 (non-monotonic at append order). Crash-truncated tail records are tolerated.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {},
      reads: ["docs/.index/checks/counters.jsonl", "docs/validator-inventory.generated.yaml"],
      writes: [],
      execute: runCountersValidate,
    },
  ],
  pipelines: [],
};
