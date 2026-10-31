/*
<MODULE_CONTRACT>
<purpose>Register forgeGateModule — gate.probe + gate.probe.catalog (RFC-1469): fixture-driven gate liveness.</purpose>
<non-goals>
  <item>Autonomous module — fixtures inject at their real workspace path (backup → invoke → restore); the check runs against the live tree (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1469: forgeGateModule registering gate.probe + gate.probe.catalog</item>
  <item>RFC-1469: gate liveness probes — gate.probe fixture runner + probe.catalog coverage read-model</item>
  <item>RFC-1469: apply r1 repairs — in-tree injection + invoke, ruleId-matched verdicts, yamlParse catalog, PROBE-02/05, real fixtures</item>
  <item>RFC-1469: apply r2 repairs — contracts-root inventory join, PROBE-03/05 declarations, dir-skeleton sweep, stale doc text</item>
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
      writes: [".agents/**", "packages/**"],
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
      ],
      description:
        "RFC-1469: fixture-inventory read-model — per-contract coverage + unprobed error-severity rules (PROBE-03) + stale fixture bindings (PROBE-05).",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {},
      reads: ["docs/gate-probes/**", "docs/validator-inventory.generated.yaml"],
      execute: runGateProbeCatalog,
    },
  ],
  pipelines: [],
};
