/*
<MODULE_CONTRACT>
<purpose>Register forge.conformance.run and forge.conformance.validate with the
forge kernel registry (RFC-1365) — golden-conformance runs for declared
contract producers plus the CONF-01..06 declaration lint.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/conformance-run.ts and handlers/conformance-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1365: step 2 — forge.conformance.run/validate commands + dual-surface registration</item>
  <item>RFC-1365: review round 1 — CONF-03 rescoped producer-side (Q-9), producers[] json shape, crash guard + leg output, transport attribution, env semantics, writes declared, regen sweep</item>
  <item>RFC-1366: kernel resolves mission workpieceEnv + KERNEL-ENV-01 gate on required envInputs</item>
  <item>RFC-1461: declare rules[] severity via CommandRuleDecl workspace-wide (RFC-1461)</item>
  <item>RFC-1539: amend dna-55 and dna-115 for published spec packages

Guides, fo-spec-ingest routing, command descriptions and regenerated command docs, remediation entries for SPEC-15..18 and CONF-07..09; resyncs the stale .agents fo-system-dispatch mirror (ADR-0126 source line).</item>
  <history>RFC-1365</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeConformanceModule(): Promise<ForgeModule> {
  const { runConformanceRun } = await import("./handlers/conformance-run.ts");
  const { runConformanceValidate } = await import("./handlers/conformance-validate.ts");
  return {
    name: "forge-conformance",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "forge.conformance.run",
        description:
          "Run golden-conformance legs (emit → mirror → consumer) for declared " +
          "contractProducers[] against the authoritative consumer validator " +
          "(RFC-1365). One shared execution path backs this command and the " +
          "@warpgogol/forge/conformance vitest helper. A consumer.package consumer " +
          "(RFC-1539) runs its installed bin and never self-skips. An absent consumer.root " +
          "self-skips with an explicit verdict; --require-consumer or " +
          "FORGE_CONFORMANCE_REQUIRE=1 fails closed instead. Aggregate exit: " +
          "1 iff any producer verdict is fail; {pass, skip} mixes exit 0. " +
          "Read-only against the repo — legs write only the mkdtemp bundle dir.",
        scope: "workspace",
        mutatesState: false,
        execOnReadOnly: true,
        writes: [],
        envInputs: [{ name: "FORGE_CONFORMANCE_REQUIRE", required: false }],
        acceptsAllFlag: true,
        coverage: "operator",
        coverageNote:
          "Operator-facing conformance runner — invoked directly in producer repos " +
          "(standalone forge CLI) and via `werkstatt run` in workshops; also " +
          "reachable from producer test files wiring forge.conformance.run.",
        reads: ["forge.yaml"],
        cacheable: false,
        flags: {
          producer: {
            kind: "string[]",
            required: false,
            description:
              "Producer id to run (repeatable — each occurrence adds to the subset). Cannot be combined with --all.",
          },
          all: {
            kind: "boolean",
            required: false,
            description:
              "Run every declared contract producer. Cannot be combined with --producer.",
          },
          "require-consumer": {
            kind: "boolean",
            required: false,
            description:
              "Fail closed when a declared consumer.root is absent instead of self-skipping. Equivalent to FORGE_CONFORMANCE_REQUIRE=1.",
          },
        },
        execute: runConformanceRun,
      },
      {
        name: "forge.conformance.validate",
        description:
          "Fail-closed lint over forge.yaml contractProducers[] declarations " +
          "(RFC-1365). CONF-01 malformed entry / missing {bundle} placeholder, " +
          "CONF-02 missing or unwired conformance test (must reference " +
          "@warpgogol/forge/conformance or forge.conformance.run), CONF-03 " +
          "unresolvable producer-side argv script path, CONF-04 consumer.root absent on this " +
          "machine (warning — dead-gate risk), CONF-05 duplicate producer id, " +
          "CONF-06 mirror omitted (warning — drift leg unarmed); RFC-1539 CONF-07 " +
          "consumer.package not an exact-pinned devDependency, CONF-08 consumer.package " +
          "not installed or its bin missing, CONF-09 consumer.root while a published " +
          "conformance validator is installed (warning). No producers " +
          "declared → pass with no work.",
        scope: "workspace",
        contract: "conformance",
        rules: [
          { id: "CONF-01", severity: "error" },
          { id: "CONF-02", severity: "error" },
          { id: "CONF-03", severity: "error" },
          { id: "CONF-04", severity: "error" },
          { id: "CONF-05", severity: "error" },
          { id: "CONF-06", severity: "error" },
          { id: "CONF-07", severity: "error" },
          { id: "CONF-08", severity: "error" },
          { id: "CONF-09", severity: "warning" },
        ],
        mutatesState: false,
        writes: [],
        coverage: "operator",
        coverageNote:
          "Operator-facing declaration lint — run directly or wired into " +
          "producer-repo pipelines; registers CONF-01..06 in the validator " +
          "inventory.",
        reads: ["forge.yaml", "contractProducers[].test (declared test paths)"],
        cacheable: false,
        flags: {},
        execute: runConformanceValidate,
      },
    ],
    pipelines: [],
  };
}
