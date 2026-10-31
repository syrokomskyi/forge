/*
<MODULE_CONTRACT>
<purpose>Register forgeChecksModule — checks.contribution.report (RFC-1473): per-rule marginal-contribution read-model for gate-catalog maintenance.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1473: forgeChecksModule registering checks.contribution.report</item>
  <item>RFC-1473: checks.contribution.report — per-rule marginal-contribution read-model over firing history + escapes</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runContributionReport } from "./handlers/contribution-report.ts";

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
      rules: [],
      description:
        "RFC-1473: per-rule marginal-contribution read-model — emitted/uniqueEmitted/zeroStreak/escapeCount + earning|silent|redundant|guard verdicts + variantCandidates. Writes docs/metrics/check-contribution.generated.yaml (coverage: partial until RFC-1469 counters land). Flags: --window, --contract, --check.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        window: { kind: "string", description: "Reporting window in sidecar count (default 20)." },
        contract: { kind: "string", description: "Restrict to one contract." },
        check: { kind: "boolean", description: "Read-only — no metrics write." },
      },
      reads: ["docs/validator-inventory.generated.yaml", "docs/sessions/audit/*.audit.yaml", "docs/frictions.yaml"],
      writes: ["docs/metrics/check-contribution.generated.yaml"],
      generates: [{ path: "docs/metrics/check-contribution.generated.yaml", phase: "on-demand" as const }],
      execute: runContributionReport,
    },
  ],
  pipelines: [],
};
