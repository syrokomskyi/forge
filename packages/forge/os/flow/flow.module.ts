/*
<MODULE_CONTRACT>
<purpose>Register flow.check and flow.install with the forge kernel registry
(RFC-1486) — the fixed branch model's read-only validator (FLOW-01..05) and
the idempotent two-phase repository adoption (FLOW-ADOPT-01..06, -08).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/flow-check.ts and handlers/flow-install.ts.</item>
  <item>No pipeline wiring — activation is the wave-4 switch-over RFC.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 5 — forge-flow module with flow.check + flow.install</item>
  <item>RFC-1486: step 5 — forge-flow module registration + dual CLI/kernel wiring</item>
  <item>RFC-1486: steps 5-6 — flow.install generates declaration, FLOW remediation catalog, regenerated artifacts</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeFlowModule(): Promise<ForgeModule> {
  const { runFlowCheck } = await import("./handlers/flow-check.ts");
  const { runFlowInstall } = await import("./handlers/flow-install.ts");
  return {
    name: "forge-flow",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "flow.check",
        description:
          "Read-only fixed-branch-model validator (RFC-1486). Reports FLOW-01 " +
          "(local branch outside the model), FLOW-02 (missing develop), " +
          "FLOW-03 (guard not installed: core.hooksPath, managed block or " +
          "byte-exact flow-guard.sh), FLOW-04 (warning — main ahead of " +
          "develop, a back-merge is owed) and FLOW-05 (forge.generated.yaml " +
          "fails the forge/generated@1 schema). Generated repositories return " +
          "an exempt verdict with the parsed marker; ungoverned repositories " +
          "report their kind with no diagnostics. Exit 1 iff an " +
          "error-severity diagnostic exists.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-01", severity: "error" },
          { id: "FLOW-02", severity: "error" },
          { id: "FLOW-03", severity: "error" },
          { id: "FLOW-04", severity: "warning" },
          { id: "FLOW-05", severity: "error" },
        ],
        mutatesState: false,
        execOnReadOnly: true,
        writes: [],
        coverage: "operator",
        coverageNote:
          "adoption/model check — wired into pipelines by the wave-4 switch-over RFC",
        reads: ["forge.yaml", "forge.generated.yaml", ".git/**", "hooks/**"],
        cacheable: false,
        flags: {},
        execute: runFlowCheck,
      },
      {
        name: "flow.install",
        description:
          "Adopt the fixed branch model in this repository (RFC-1486), " +
          "idempotent and two-phase: the plan phase evaluates every " +
          "precondition without mutating (refusals FLOW-ADOPT-01..06, -08 " +
          "exit 1 with nothing changed; --dry-run stops here), then the " +
          "execute phase levels develop with main, points core.hooksPath at " +
          "hooks/, switches the clean primary to develop, installs " +
          "hooks/flow-guard.sh byte-exact plus the managed pre-commit block, " +
          "and lands one adoption commit on develop under " +
          "FORGE_FLOW_OP=install. Step 9 embeds a flow.check report.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-ADOPT-01", severity: "error" },
          { id: "FLOW-ADOPT-02", severity: "error" },
          { id: "FLOW-ADOPT-03", severity: "error" },
          { id: "FLOW-ADOPT-04", severity: "error" },
          { id: "FLOW-ADOPT-05", severity: "error" },
          { id: "FLOW-ADOPT-06", severity: "error" },
          { id: "FLOW-ADOPT-08", severity: "error" },
        ],
        mutatesState: true,
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: ["hooks/pre-commit", "hooks/flow-guard.sh", ".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote:
          "run once per repository at adoption — wired into forge.upgrade by the wave-4 switch-over RFC",
        reads: ["forge.yaml", "forge.generated.yaml", ".git/**", "hooks/**"],
        cacheable: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            required: false,
            description:
              "Plan phase only — report the computed steps[] without mutating anything.",
          },
        },
        execute: runFlowInstall,
      },
    ],
    pipelines: [],
  };
}
