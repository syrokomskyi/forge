/*
<MODULE_CONTRACT>
<purpose>Register proof.check with the forge kernel registry (RFC-1391) —
runs a forge/proof-spec@1 spec through the pinned checker and returns the
mechanical verdict that backs formal-tier acceptance evidence.</purpose>
<non-goals>
  <item>Do not implement verdict logic here — delegate to handlers/proof-check.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1391: forge-formal module with proof.check.</item>
  <item>RFC-1391: make the formal verification tier checker-bound (RFC-1391)</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeFormalModule(): Promise<ForgeModule> {
  const { runProofCheckCommand } = await import("./handlers/proof-check.ts");
  return {
    name: "forge-formal",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "proof.check",
        description:
          "Run one forge/proof-spec@1 proof spec through its pinned checker " +
          "(RFC-1391). The built-in `exhaustive` tool enumerates a finite " +
          "domain against a check function in a *.proof.test.ts entry; " +
          "external checkers resolve from forge.yaml formal.tools. Verdicts: " +
          "proved | refuted | unavailable | error — exit 0 only on proved. " +
          "This is the only sanctioned source of formal-tier evidence; an " +
          "agent argument, sampled property test, or absent checker can never " +
          "produce `proved`.",
        scope: "workspace",
        contract: "formal-proof",
        rules: [],
        mutatesState: true,
        execOnReadOnly: true,
        writes: [".cache/proofs/**"],
        generates: [],
        coverage: "operator",
        coverageNote:
          "Operator-facing proof runner — invoked directly and by `probe: proof` " +
          "acceptance probes during rfc.acceptance.run / rfc.verification.emit; " +
          "kept out of the regular build pipeline per RFC-1391.",
        reads: ["forge.yaml", "<spec>", "<spec entry>"],
        cacheable: false,
        flags: {
          spec: {
            kind: "string",
            required: true,
            description: "Workspace-relative path to a forge/proof-spec@1 YAML file.",
          },
          "timeout-ms": {
            kind: "string",
            description: "Per-run checker timeout bound in milliseconds (default 30 min).",
          },
        },
        execute: runProofCheckCommand,
      },
    ],
    pipelines: [],
  };
}
