/*
<MODULE_CONTRACT>
<purpose>Register the correctness contour commands (contract `correctness`)
with the forge registry — RFC-1578 `correctness.manifest.validate`, RFC-1579
`correctness.audit`, RFC-1580 `correctness.gate`.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1578: correctness manifest, validator, promotes gate

Add os/correctness (forge/correctness-manifest@1, correctness.manifest.validate CORR-01..09), bindings.paths.correctnessManifest, bindings.commands.checkRun and the correctness section, promotes with V-55 and RFC-IMP-16, the typescript profile skeleton, reference pages, and the promotes marking in fo-idea-create-rfc/fo-idea-audit. Repoint the RFC-1391 AC-8 registry test at src/command-modules.ts (stale since RFC-1573) and close the types.ts header comment without a glob-shaped terminator (EC-33).</item>
  <item>RFC-1578: close review REVIEW-CODE-2026-11-12-08 findings

F1 code-only anchor scan (markdown fences never declare anchors); F2 generated index as a re-verified hint, scan on any miss; F3 RFC-IMP-16 asserted through rfc.implement.stamp; F4 forge create patches only absent/null keys; F5 type: refs normalized; F6/F10/F11 capture existence via existsSync, future recordedAt and workspace-escaping paths are CORR-07; F7 V-55 reuses criteriaEval; F8 validator inventory regenerated; F9 binding-driven reads; F12 git listing, index hint, create patch tests; DEV-1 single sidecar spelling; DEV-2 output field dropped.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
  <item>RFC-1579: gate line, ecosystem.commit early run, reference page

typescript profile integration-gate.sh runs the primary install's correctness.audit against FLOW_BASE_SHA; werkstatt ecosystem.commit gains EC-34 (correctness.audit --staged, refuses introduced CORR-AUDIT-01..03, warns on CORR-AUDIT-04); in-code CREATE TABLE tables (Durable Object storage) are unverifiable instead of D1 findings; correctness.audit declares generates: []; reference page and agent guides.

Measured on werkstatt (rollout step 3): 7 wrangler D1 configs, ~10 s per run, 3 legacy sql.schema.conform findings (packages/warpgogol-billing-cloudflare against schemas outside the repo), 127 unverifiable statements, no state machines; CORR-AUDIT-04 present (verify equals test) — fixed by the werkstatt gate-wiring queue task.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <history>RFC-1578</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeCorrectnessModule(): Promise<ForgeModule> {
  const { runCorrectnessManifestValidate } = await import("./handlers/validate.ts");
  const { runCorrectnessAuditCommand } = await import("./handlers/audit.ts");
  const { runCorrectnessGateCommand } = await import("./handlers/gate.ts");
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
        // The survival ledger is dated state, not a deterministic projection.
        generates: [],
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
      {
        name: "correctness.gate",
        description:
          "Enforce the product correctness manifest at integration (RFC-1580). Spawned by " +
          "flow.integrate from the primary checkout's forge install. CORR-GATE-01 manifest " +
          "invalid at HEAD; CORR-GATE-02 weakening against the frozen set at --base (entries, " +
          "oracles, substrates, exemptions, allow-list, bindings, mode/tier, anchor statements, " +
          "any byte change of a frozen oracle/capture/support file not made by a verifier-trailer " +
          "commit) — refuses in warn mode too; CORR-GATE-03 only self oracles (no committed " +
          "forge/oracle-review@1 record, no verifier trailer, not unchanged since acceptance); " +
          "CORR-GATE-04 L1/L2 without a matching schema-hash attestation; CORR-GATE-05 lifecycle " +
          "anchor without a verified forge.anchor event; CORR-GATE-06 tier high/formal origin or " +
          "proof requirements; CORR-GATE-07 oracle run failed or timed out; CORR-GATE-08 entry " +
          "uncovered. warn mode downgrades 03..08 to warnings. Writes a forge/correctness-bundle@1 " +
          "under <git-common-dir>/forge/gate-reports/.",
        scope: "workspace",
        contract: "correctness",
        rules: [
          { id: "CORR-GATE-01", severity: "error" },
          { id: "CORR-GATE-02", severity: "error" },
          { id: "CORR-GATE-03", severity: "error" },
          { id: "CORR-GATE-04", severity: "error" },
          { id: "CORR-GATE-05", severity: "error" },
          { id: "CORR-GATE-06", severity: "error" },
          { id: "CORR-GATE-07", severity: "error" },
          { id: "CORR-GATE-08", severity: "error" },
        ],
        // Writes its forge/correctness-bundle@1 and spawns the oracles (checkRun).
        mutatesState: true,
        writes: [".git/forge/gate-reports/**"],
        generates: [],
        execOnReadOnly: true,
        reads: ["forge.yaml"],
        cacheable: false,
        flags: {
          base: {
            kind: "string",
            required: true,
            description: "Develop tip the session integrates into — the frozen set is read here.",
          },
          "accept-weakening": {
            kind: "string",
            description:
              "Operator decision: accept the weakening of an isolated session whose diff touches frozen-set paths only.",
          },
        },
        execute: runCorrectnessGateCommand,
      },
    ],
    pipelines: [],
  };
}
