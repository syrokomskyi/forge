/*
<MODULE_CONTRACT>
<purpose>RFC-1616: adversarial.run — the demonstration harness. Replays the
packaged scenario catalog in a scratch clone of this repository and reports
scenario → expected → observed → rule, exiting non-zero on any mismatch.
--list enumerates the catalog; --scenario runs one.</purpose>
<non-goals>
  <item>Not a per-PR gate — on-demand/CI-scheduled by design (runtime cost is per-scenario clone+spawn).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial module — adversarial.run.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
  <item>RFC-1616: declare VITEST env input on adversarial.run</item>
  <item>RFC-1616: declare subprocess env inputs and drop pull_request trigger</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";
import type { AdversarialResult, AdversarialScenarioResult } from "../../src/adversarial/types.ts";
import { loadCatalog } from "./catalog.ts";
import { runScenario } from "./runner.ts";

async function runAdversarial(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AdversarialResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const json = input.flags["json"] === true || outputFormat === "json";
  const listOnly = input.flags["list"] === true;
  const only = typeof input.flags["scenario"] === "string" ? input.flags["scenario"] : null;

  const catalog = loadCatalog();
  if (listOnly) {
    if (!json) {
      for (const e of catalog) {
        logger.info(
          e.scenario
            ? `${e.name} → ${e.scenario.expect.rule}${e.scenario.requires?.length ? ` (${e.scenario.requires.join(", ")})` : ""}`
            : `${e.name} → INVALID: ${e.error}`,
        );
      }
    }
    const scenarios = catalog.map((e) => ({
      name: e.name,
      expected: e.scenario?.expect.rule ?? "invalid",
      observed: "not-run",
      ok: e.scenario !== undefined,
    }));
    return {
      data: {
        command: "adversarial.run",
        scenarios,
        status: catalog.every((e) => e.scenario) ? "pass" : "fail",
      },
      exitCode: catalog.every((e) => e.scenario) ? 0 : 1,
      summary: `${catalog.length} scenario(s) in catalog`,
    };
  }

  const selected = only ? catalog.filter((e) => e.name === only) : catalog;
  if (only && selected.length === 0) {
    return {
      data: { command: "adversarial.run", scenarios: [], status: "fail" },
      exitCode: 1,
      summary: `no scenario named ${only}`,
    };
  }
  const invalid = selected.filter((e) => !e.scenario);
  const results: AdversarialScenarioResult[] = invalid.map((e) => ({
    name: e.name,
    expected: "valid scenario.yaml",
    observed: `error:${e.error ?? "invalid"}`,
    ok: false,
  }));
  for (const e of selected) {
    if (!e.scenario) continue;
    const r = await runScenario(e.scenario, { repoRoot: workspaceRoot });
    results.push(r);
    if (!json) {
      (r.ok ? logger.success : logger.error).call(
        r.ok ? logger.success : logger.error,
        `${r.name} → expected ${r.expected}, observed ${r.observed}${r.ok ? "" : " — MISMATCH"}`,
      );
    }
  }
  const status = results.every((r) => r.ok) ? "pass" : "fail";
  return {
    data: { command: "adversarial.run", scenarios: results, status },
    exitCode: status === "pass" ? 0 : 1,
    summary: `${results.filter((r) => r.ok).length}/${results.length} scenario(s) refused as expected`,
  };
}

export function createForgeAdversarialModule(): ForgeModule {
  return {
    name: "forge-adversarial",
    version: "0.0.0",
    runtime: "autonomous",
    declarations: [],
    pipelines: [],
    commands: [
      {
        name: "adversarial.run",
        coverage: "operator" as const,
        coverageNote: "trust-boundary demonstration (RFC-1616)",
        mutatesState: false,
        execOnReadOnly: true,
        description:
          "Replay the packaged adversarial scenario catalog in a scratch clone " +
          "of this repository — each scenario seeds the repo, applies an attack " +
          "edit, spawns the real gate, and verifies the expected refusal rule " +
          "(CORR-GATE-02/03, FLOW-INT-18). --list enumerates, --scenario runs " +
          "one. Exit non-zero on any expected-vs-observed mismatch.",
        scope: "workspace",
        reads: ["docs/adversarial/**"],
        writes: [],
        generates: [],
        cacheable: false,
        envInputs: [
          { name: "FORGE_ADVERSARIAL_BIN", required: false },
          { name: "VITEST", required: false },
          { name: "COMSPEC", required: false },
          { name: "PATHEXT", required: false },
          { name: "PATH", required: false },
        ],
        flags: {
          list: { kind: "boolean", description: "List catalog scenarios without running." },
          scenario: { kind: "string", description: "Run only the named scenario." },
          json: { kind: "boolean", description: "Output structured JSON result." },
        },
        execute: runAdversarial,
      },
    ],
  };
}
