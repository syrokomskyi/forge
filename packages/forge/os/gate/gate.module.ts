/*
<MODULE_CONTRACT>
<purpose>Register forgeGateModule — gate.probe + gate.probe.catalog (RFC-1469): fixture-driven gate liveness.</purpose>
<non-goals>
  <item>Autonomous module — fixtures inject at their real workspace path (backup → invoke → restore); the check runs against the live tree (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1469: gate liveness probes — gate.probe fixture runner + probe.catalog coverage read-model</item>
  <item>RFC-1469: apply r1 repairs — in-tree injection + invoke, ruleId-matched verdicts, yamlParse catalog, PROBE-02/05, real fixtures</item>
  <item>RFC-1469: apply r2 repairs — contracts-root inventory join, PROBE-03/05 declarations, dir-skeleton sweep, stale doc text</item>
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
  <item>RFC-1592: retire 7 unprobeable blocking rules and probe COMPASS-DOC-01/KAUTHZ-01, unblocking the RFC-1592 ratchet</item>
  <history>RFC-1469</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runGateProbe } from "./handlers/gate-probe.ts";
import { runGateProbeCatalog } from "./handlers/gate-probe-catalog.ts";

export const forgeGateModule: ForgeModule = {
  name: "forge-gate",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "gate.probe",
      coverage: "operator" as const,
      mutatesState: true,
      contract: "gate",
      rules: [
        { id: "PROBE-01", severity: "error" },
        { id: "PROBE-02", severity: "warning" },
        { id: "PROBE-05", severity: "warning" },
      ],
      description:
        "RFC-1469: inject a declared violation at its real workspace path (backup → invoke check → restore) — proves the gate still fires on its real scan path. Flags: --rule, --contract, --all, --list.",
      scope: "workspace",
      acceptsAllFlag: true,
      flags: {
        rule: { kind: "string", description: "Probe a single rule's fixture." },
        contract: { kind: "string", description: "Probe every fixture under a contract." },
        list: { kind: "boolean", description: "Inventory the bound fixtures without executing." },
      },
      reads: ["docs/gate-probes/**", ".agents/**", "packages/forge/skills/**"],
      writes: [".agents/**", "packages/**", "docs/.index/gate-probes/runs.jsonl"],
      generates: [],
      execute: runGateProbe,
    },
    {
      name: "gate.probe.catalog",
      coverage: "operator" as const,
      mutatesState: false,
      contract: "gate",
      rules: [
        { id: "PROBE-03", severity: "warning" },
        { id: "PROBE-05", severity: "warning" },
        { id: "PROBE-06", severity: "error" },
        { id: "PROBE-07", severity: "error" },
        { id: "PROBE-08", severity: "error" },
      ],
      description:
        "RFC-1469: fixture-inventory read-model — per-contract coverage + unprobed error-severity rules (PROBE-03) + stale fixture bindings (PROBE-05). RFC-1592 liveness ratchet: --check fails PROBE-06 (unprobed rule outside the shrink-only baseline), PROBE-07 (stale baseline entry), PROBE-09 (expired/undeclared provisional warning); --write-baseline creates or shrink-rewrites docs/gate-probes/unprobed.baseline.generated.yaml (PROBE-08 refuses growth). Flags: --check, --write-baseline.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        check: { kind: "boolean", description: "Ratchet check — PROBE-06/07/09 gate verdict." },
        "write-baseline": {
          kind: "boolean",
          description: "Create or shrink-rewrite the unprobed-rule baseline (never grows).",
        },
      },
      mutatingFlags: ["write-baseline"],
      reads: [
        "docs/gate-probes/**",
        "docs/validator-inventory.generated.yaml",
        "docs/.index/gate-probes/runs.jsonl",
        "docs/.index/checks/counters.jsonl",
        "packages/**/*.ts",
      ],
      execute: runGateProbeCatalog,
    },
  ],
  pipelines: [],
};
