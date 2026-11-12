/*
<MODULE_CONTRACT>
<purpose>Register the correctness contour commands (contract `correctness`)
with the forge registry — RFC-1578 `correctness.manifest.validate`, RFC-1579
`correctness.audit`.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: initial module — correctness.manifest.validate, rules CORR-01..09.</item>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-08 findings

F1 code-only anchor scan (markdown fences never declare anchors); F2 generated index as a re-verified hint, scan on any miss; F3 RFC-IMP-16 asserted through rfc.implement.stamp; F4 forge create patches only absent/null keys; F5 type: refs normalized; F6/F10/F11 capture existence via existsSync, future recordedAt and workspace-escaping paths are CORR-07; F7 V-55 reuses criteriaEval; F8 validator inventory regenerated; F9 binding-driven reads; F12 git listing, index hint, create patch tests; DEV-1 single sidecar spelling; DEV-2 output field dropped.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeCorrectnessModule(): Promise<ForgeModule> {
  const { runCorrectnessManifestValidate } = await import("./handlers/validate.ts");
  const { runCorrectnessAuditCommand } = await import("./handlers/audit.ts");
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
        // The manifest path is binding-driven (bindings.paths.correctnessManifest).
        reads: ["forge.yaml"],
        cacheable: false,
        flags: {},
        execute: runCorrectnessManifestValidate,
      },
      {
        name: "correctness.audit",
        description:
          "Audit cross-artifact correctness defects (RFC-1579). CORR-AUDIT-01 " +
          "sql.schema.conform — SQL literals in non-test TypeScript must prepare against " +
          "the D1 schema their package's wrangler.json/jsonc migrations build (node:sqlite); " +
          "CORR-AUDIT-02 ledger.orphans — every declared table needs a writer and a reader; " +
          "CORR-AUDIT-03 state.transitions.coverage — every target of a " +
          "@state-machine[<name>] (writers: …) table needs a writer; CORR-AUDIT-04 " +
          "bindings.verify.substance — bindings.commands.verify must prove more than " +
          "tests/types. Code findings block only when introduced relative to --base " +
          "(default: merge-base with develop; HEAD with --staged); the configuration " +
          "finding blocks whenever present. correctness.audit.allow[] entries report as " +
          "accepted. --write-ledger refreshes the survival ledger " +
          "(bindings.paths.correctnessLedger) — the only mutating mode.",
        scope: "workspace",
        contract: "correctness",
        rules: [
          { id: "CORR-AUDIT-01", severity: "error" },
          { id: "CORR-AUDIT-02", severity: "error" },
          { id: "CORR-AUDIT-03", severity: "error" },
          { id: "CORR-AUDIT-04", severity: "error" },
        ],
        mutatesState: true,
        execOnReadOnly: true,
        reads: ["forge.yaml"],
        writes: ["docs/maintenance-debt/correctness.ledger.yaml"],
        cacheable: false,
        flags: {
          base: {
            kind: "string",
            description:
              "Revision findings are compared against (default: merge-base with develop; HEAD with --staged).",
          },
          staged: {
            kind: "boolean",
            description: "Judge the staged index instead of the working tree.",
          },
          check: {
            kind: "string",
            description:
              "Run one auditor: sql.schema.conform | ledger.orphans | state.transitions.coverage | bindings.verify.substance.",
          },
          "write-ledger": {
            kind: "boolean",
            description:
              "Refresh the survival ledger at bindings.paths.correctnessLedger (honours --dry-run).",
          },
        },
        execute: runCorrectnessAuditCommand,
      },
    ],
    pipelines: [],
  };
}
