/*
<MODULE_CONTRACT>
<purpose>Register forgeChecksModule — checks.contribution.report (RFC-1473) per-rule marginal-contribution read-model for gate-catalog maintenance, plus the RFC-1474 counters surface: checks.counters.export (deterministic per-rule totals projection) and checks.counters.validate (journal integrity gate vs the validator inventory).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1473: forgeChecksModule registering checks.contribution.report</item>
  <item>RFC-1473: checks.contribution.report — per-rule marginal-contribution read-model over firing history + escapes</item>
  <item>RFC-1474: per-rule check-execution counters

Append-only counters.jsonl journaled per evaluated rule ({runId, ruleId, contract, outcome, at}; runId = commandInvocationId; outcomes pass|diagnostic|skipped|ensured; dry-run suppressed; append failures warn never fail). checks.counters.validate audits the journal against the validator inventory (COUNT-01/02); checks.counters.export projects deterministic per-rule totals (COUNT-03, generatedAt = max journal at; producer-tail tolerated). checks.contribution.report joins counters as the canonical firing source (CONTRIB-03 on absent/empty journal; coverage none|partial|complete; live effectiveCoverage positive). Validator inventory now includes every rules[]-declaring command — fail-closed gate surfaced 9 contract-declaration defects, fixed with domain contracts.</item>
  <item>RFC-1474: check-execution counters — apply review findings (F-1..F-9)</item>
  <item>RFC-1474: check-execution counters — apply re-review findings (structural skip flag, violations extraction, Date.parse ordering, DEV-5/6)</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runContributionReport } from "./handlers/contribution-report.ts";
import { runCountersExport } from "./handlers/counters-export.ts";
import { runCountersValidate } from "./handlers/counters-validate.ts";

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
        "docs/sessions/audit/*.audit.yaml",
        "docs/frictions.yaml",
      ],
      writes: ["docs/metrics/check-contribution.generated.yaml"],
      generates: [{ path: "docs/metrics/check-contribution.generated.yaml", phase: "on-demand" as const }],
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
        out: { kind: "string", description: "Artifact path override (default docs/metrics/check-counters.generated.yaml)." },
        check: { kind: "boolean", description: "Read-only — diff the computed artifact against the committed file (COUNT-03)." },
      },
      reads: ["docs/.index/checks/counters.jsonl"],
      writes: ["docs/metrics/check-counters.generated.yaml"],
      generates: [{ path: "docs/metrics/check-counters.generated.yaml", phase: "on-demand" as const }],
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
