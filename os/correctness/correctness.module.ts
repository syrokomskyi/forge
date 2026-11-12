/*
<MODULE_CONTRACT>
<purpose>Register the correctness contour commands (contract `correctness`)
with the forge registry — RFC-1578 `correctness.manifest.validate`.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial module — correctness.manifest.validate, rules CORR-01..09.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeCorrectnessModule(): Promise<ForgeModule> {
  const { runCorrectnessManifestValidate } = await import("./handlers/validate.ts");
  return {
    name: "forge-correctness",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "correctness.manifest.validate",
        description:
          "Validate the product correctness manifest (forge/correctness-manifest@1, " +
          "bindings.paths.correctnessManifest) and the forge.yaml correctness section " +
          "(RFC-1578). CORR-01 manifest/checkRun presence (error in enforce, warning in " +
          "warn); CORR-02 schema, ids, support globs, mode/tier values; CORR-03 requirement, " +
          "DNA, RFC AC/FI refs resolve; CORR-04 anchors are tagged @ai-invariant ids with a " +
          "checked-by binding; CORR-05 each oracle check is named by an anchor's checked-by; " +
          "CORR-06 seam substrate minimums (data L1, lifecycle L2, provider L3 or a fresh " +
          "capture); CORR-07 capture sidecar provenance and ttl (warning within 7 days of " +
          "expiry); CORR-08 every requirement id and DNA id is anchored or exempted; CORR-09 " +
          "exemption shape. correctness.mode exempt evaluates no rule. Read-only.",
        scope: "workspace",
        contract: "correctness",
        rules: [
          { id: "CORR-01", severity: "error" },
          { id: "CORR-02", severity: "error" },
          { id: "CORR-03", severity: "error" },
          { id: "CORR-04", severity: "error" },
          { id: "CORR-05", severity: "error" },
          { id: "CORR-06", severity: "error" },
          { id: "CORR-07", severity: "error" },
          { id: "CORR-08", severity: "error" },
          { id: "CORR-09", severity: "error" },
        ],
        mutatesState: false,
        execOnReadOnly: true,
        reads: ["forge.yaml", "docs/correctness.yaml"],
        cacheable: false,
        flags: {},
        execute: runCorrectnessManifestValidate,
      },
    ],
    pipelines: [],
  };
}
