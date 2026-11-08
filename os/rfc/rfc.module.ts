/*
<MODULE_CONTRACT>
<purpose>Facilitates the registration and execution of commands related to RFC management within the workspace.</purpose>
<non-goals>
  <item>Do not manage RFC storage or persistence mechanisms.</item>
  <item>Do not handle user interface concerns or command-line parsing.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1483: self-sufficient implement stamp — default repair pass, ordered remediation checklist, --no-repair</item>
  <item>RFC-1489: batch test probes through one instrumented Vitest run + frontmatter corpus reads

runProbeSet is the single shared execution point: barrier-free segments of test probes sharing one effective bound run in one vitest --reporter=json --outputFile process with per-(file,testName) attribution; missing files/reports yield unverified. run/page/proof and all non-test kinds are barriers. --no-batch escapes to the legacy path on acceptance.run, verification.emit and verification.refresh. rfc.validate reads non-target corpus files frontmatter-only via readRfcFrontmatter (64 KiB bound, full-parse fallback); emit/refresh/acceptance corpus scans use the same accessor. Corpus map slimmed to RfcCorpusEntry {fileName, frontmatter}.</item>
  <item>RFC-1516: add an evidence-freshness window to the stamp-sync chain for rfc-1516</item>
  <item>RFC-1528: close review findings — manifest-union command inventory for regen/preflight</item>
  <item>RFC-1534: lint probe patterns, sync amends counterparts, name next free ledger id</item>
  <history>RFC-0260, RFC-0795, RFC-1097, RFC-1173, RFC-1231, RFC-1237, RFC-1249, RFC-1271, RFC-1306, RFC-1322, RFC-1333, RFC-1351, RFC-1354, RFC-1364, RFC-1453, RFC-1458, RFC-1461, RFC-1463, RFC-1467, RFC-1474, RFC-1482</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeRfcModule(): Promise<ForgeModule> {
  const {
    runRfcList,
    runRfcCreate,
    runRfcNextId,
    runRfcValidate,
    runRfcCommandLifecycleValidate,
    runRfcCheck,
    runRfcIndexGenerate,
    runRfcIndexValidate,
    runRfcGraph,
  } = await import("./handlers.ts");
  const { runRfcAcceptanceRun } = await import("./acceptance.ts");
  const { runRfcVerificationEmit } = await import("./verification-evidence.ts");
  const { runRfcVerificationRefresh } = await import("./verification-refresh.ts");
  const { runRfcDnaTraceValidate, runRfcDnaTraceGenerate } = await import("./dna-trace.ts");
  const { runRfcDecisionLogGenerate } = await import("./decision-log.ts");
  const { runRfcSupersedePropose } = await import("./handlers/supersede-propose.ts");
  const { runRfcArchive } = await import("./handlers/archive.ts");
  const { runRfcPipelineStatus } = await import("./handlers/pipeline-status.ts");
  const { runRfcImplementStamp } = await import("./handlers/implement-stamp.ts");
  const { runRfcEvidenceSync } = await import("./handlers/rfc-evidence-sync.ts");
  const { runRfcVerifyWorkspace } = await import("./verify-workspace.ts");
  // ── rfc.list ─────────────────────────────────────────────────────────────;
  return {
    name: "rfc",
    version: "0.1.0",
    runtime: "autonomous",

    declarations: [],
    commands: [
      {
        name: "rfc.list",
        mutatesState: false,
        description:
          "List all RFCs. Filter with --status, --kind, --owner flags. " +
          "Use --json for machine-readable output. " +
          "Parses frontmatter on the fly — no index file needed.",
        scope: "workspace",
        // RFC-0260: typed flag schema.
        flags: {
          status: {
            kind: "string",
            description: "Filter by RFC status (e.g. draft, accepted, implemented).",
          },
          kind: {
            kind: "string",
            description: "Filter by RFC kind (e.g. architecture, contract, command).",
          },
          owner: { kind: "string", description: "Filter by an owner string." },
          batch: {
            kind: "string",
            description: "Filter by batch slug (e.g. engine-consolidation).",
          },
        },
        reads: ["docs/rfcs/**/*.md"],
        execute: runRfcList,
      },
      {
        name: "rfc.create",
        description:
          "Create a new RFC draft from the template. " +
          'Pass --title "Short title" (required). ' +
          "Optional: --kind, --scope, --satisfies DNA-N,DNA-M. " +
          "Always creates status: draft. " +
          "AI agents are allowed to use this command.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/rfcs/RFC-*.md"],
        generates: [],
        reads: ["docs/rfcs/**/*.md"],
        cacheable: false,
        // RFC-0260: typed flag schema.
        flags: {
          title: { kind: "string", required: true, description: "Short imperative RFC title." },
          kind: {
            kind: "string",
            default: "architecture",
            description: "RFC kind: architecture | contract | command | policy | deprecation.",
          },
          scope: {
            kind: "string",
            default: "workspace",
            description: "RFC scope: app | workspace.",
          },
          satisfies: {
            kind: "string",
            description:
              "Comma-separated DNA ids this RFC satisfies. Required for architecture/contract RFCs.",
          },
          revisit: {
            kind: "string",
            description:
              "RFC-1467: acknowledge a rejected/superseded precedent colliding with this title — required when a terminal-kind decision-log hit scores at or above the reproposal threshold.",
          },
          proposed: {
            kind: "string",
            description:
              "RFC-1482: comma-separated command names seeded into commands.proposed; each name gets one `probe: reachable` acceptance stub.",
          },
          added: {
            kind: "string",
            description:
              "RFC-1482: comma-separated command names seeded into commands.added; each name gets one `probe: reachable` acceptance stub.",
          },
          amends: {
            kind: "string",
            description:
              "RFC-1534: RFC-NNNN this draft amends — seeds amends: and writes the amendedBy counterpart on the amended file in the same pass.",
          },
        },
        execute: runRfcCreate,
      },
      {
        name: "rfc.next-id",
        coverage: "operator" as const,
        mutatesState: false,
        description:
          "Return the next free RFC number (max existing + 1) by scanning docs/rfcs/ recursively including archive/.",
        scope: "workspace",
        flags: {},
        reads: ["docs/rfcs/**/*.md"],
        execute: runRfcNextId,
      },
      {
        name: "rfc.validate",
        mutatesState: false,
        contract: "rfc",
        rules: [],
        description:
          "Validate RFC frontmatter schema, required markdown sections, " +
          "referential integrity (supersedes/supersededBy), date consistency, " +
          "and RFC command lifecycle metadata (RFC-CMD-*). " +
          "Pass --id to validate a single file, or run without arguments for all.",
        scope: "workspace",
        flags: {
          id: { kind: "string", description: "Target a single RFC by id (e.g. RFC-0609)." },
          fix: {
            kind: "boolean",
            description:
              "RFC-1534: repair V-19 amends/amendedBy asymmetries by merging the missing counterpart into the referenced file.",
          },
        },
        reads: ["docs/rfcs/**/*.md"],
        execute: runRfcValidate,
      },
      {
        name: "rfc.command-lifecycle.validate",
        mutatesState: false,
        contract: "rfc",
        rules: [],
        description:
          "Validate RFC commands.proposed/added/changed/removed lifecycle metadata " +
          "against live registered commands. Emits RFC-CMD-* diagnostics.",
        scope: "workspace",
        flags: {
          id: { kind: "string", description: "Target a single RFC by id (e.g. RFC-0609)." },
        },
        reads: ["docs/rfcs/**/*.md"],
        cacheable: false,
        execute: runRfcCommandLifecycleValidate,
      },
      {
        name: "rfc.check",
        mutatesState: false,
        contract: "rfc",
        rules: [],
        description:
          "Validate that artifacts declared by accepted/implemented RFCs exist on disk. " +
          "Checks files from 'File system responsibilities' tables and feature flag references. " +
          "Use --status to override which RFC statuses to check.",
        scope: "workspace",
        // RFC-0260: typed flag schema.
        flags: {
          status: {
            kind: "string[]",
            description: "Override which RFC statuses to check (default: accepted, implemented).",
          },
        },
        reads: ["docs/rfcs/**/*.md"],
        execute: runRfcCheck,
      },
      {
        name: "rfc.index.generate",
        mutatesState: true,
        description:
          "Emit a machine-readable relationship index of all RFCs (id, status, dates, " +
          "supersedes/supersededBy/amends/amendedBy/related). Retries an unparseable RFC " +
          "file up to 3 reads; a persistent failure emits RFC-IDX-04 and fails without " +
          "writing (RFC-1364). Use --json, or --write to persist docs/rfcs/index.yaml " +
          "atomically.",
        scope: "workspace",
        // RFC-0260: typed flag schema.
        flags: {
          write: {
            kind: "boolean",
            description: "Persist the generated index to docs/rfcs/index.yaml.",
          },
        },
        reads: ["docs/rfcs/**/*.md"],
        writes: ["docs/rfcs/index.yaml"],
        generates: [
          {
            path: "docs/rfcs/index.yaml",
            phase: "on-demand",
            markerPolicy: "registry-only",
            volatile: true,
          },
        ],
        cacheable: false,
        execute: runRfcIndexGenerate,
      },
      {
        name: "rfc.index.validate",
        mutatesState: false,
        contract: "rfc",
        rules: [],
        description:
          "Validate that docs/rfcs/index.yaml exists, is parseable, and its entry count " +
          "matches the number of RFC files on disk. Reports RFC-IDX-01 (missing), " +
          "RFC-IDX-02 (unparseable), RFC-IDX-03 (count mismatch).",
        scope: "workspace",
        flags: {},
        reads: ["docs/rfcs/**/*.md", "docs/rfcs/index.yaml"],
        execute: runRfcIndexValidate,
      },
      {
        name: "rfc.graph",
        coverage: "operator" as const,
        mutatesState: false,
        description:
          "Print one RFC's relationship neighbours (supersedes/supersededBy/amends/" +
          "amendedBy/related). Pass --id RFC-0152.",
        scope: "workspace",
        flags: {
          id: { kind: "string", description: "Target a single RFC by id (e.g. RFC-0152)." },
        },
        reads: ["docs/rfcs/**/*.md"],
        execute: runRfcGraph,
      },
      {
        name: "rfc.acceptance.run",
        mutatesState: false,
        execOnReadOnly: true,
        description:
          "RFC-0268: execute the acceptance: probes declared in an RFC's frontmatter and report " +
          "pass/fail per probe (RFC-ACC-01 failed probe, RFC-ACC-02 accepted/implemented RFC with " +
          "zero probes). Requires --id <rfc-id> or --status <status>; never runs automatically inside " +
          "build pipelines.",
        scope: "workspace",
        flags: {
          id: { kind: "string", description: "Target a single RFC by id (e.g. rfc-0268)." },
          status: {
            kind: "string",
            description: "Target every RFC with this status (e.g. accepted).",
          },
          "no-batch": {
            kind: "boolean",
            description:
              "RFC-1489: disable test-probe batching — run each probe in its own Vitest process (diagnostic escape).",
          },
        },
        reads: ["docs/rfcs/**/*.md"],
        cacheable: false,
        execute: runRfcAcceptanceRun,
      },
      {
        name: "rfc.verify.workspace",
        modulePath: "packages/forge/os/rfc/rfc.module.ts",
        description:
          "RFC-1333: export a committed candidate as a git-free tree under the OS temp dir for a " +
          "clean-context acceptance verifier — implementer in-range tests, the RFC's plan/review/" +
          "session/queue documents, and its evidence envelope are stripped; VERIFY-BUNDLE.md carries " +
          "only the RFC's Context/Problem/Decision/Design/Acceptance criteria. Writes nothing in the repository. " +
          "Required flags: `--id`, `--candidate`.",
        scope: "workspace",
        // Exports via `git archive | tar -x` subprocesses + temp-dir writes —
        // read-only toward the repository; execOnReadOnly keeps the subprocess
        // surface declared without claiming repository writes.
        mutatesState: false,
        execOnReadOnly: true,
        contract: "rfc",
        rules: [],
        coverage: "operator",
        writes: [],
        reads: ["docs/rfcs/**/*.md"],
        cacheable: false,
        flags: {
          id: { kind: "string", required: true, description: "Target RFC id." },
          candidate: {
            kind: "string",
            required: true,
            description: "Committed candidate SHA to export.",
          },
        },
        execute: runRfcVerifyWorkspace,
      },
      {
        name: "rfc.verification.emit",
        // RFC-1453 outcome waiver records the operator identity from USER/USERNAME.
        envInputs: [
          { name: "USER", required: false },
          { name: "USERNAME", required: false },
        ],
        modulePath: "packages/forge/os/rfc/rfc.module.ts",
        description:
          "RFC-0330: execute acceptance probes for target RFC(s) and write per-RFC verification " +
          "evidence artifacts to docs/rfcs/verification/*.generated.yaml. Requires --id <rfc-id> " +
          "or --status <status>. Reuses runProbe from RFC-0268. Writes via the WorkspaceIO port " +
          "(io.writeFile); --dry-run runs probes and reports without writing (RFC-1237).",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/rfcs/verification/*.generated.yaml"],
        generates: [{ path: "docs/rfcs/verification/*.generated.yaml", phase: "on-demand" }],
        reads: ["docs/rfcs/**/*.md"],
        cacheable: false,
        flags: {
          id: { kind: "string", description: "Target a single RFC by id (e.g. rfc-0330)." },
          status: {
            kind: "string",
            description: "Target every RFC with this status (e.g. implemented).",
          },
          "dry-run": {
            kind: "boolean",
            description: "Run probes and report results without writing envelope files.",
          },
          check: {
            kind: "boolean",
            description:
              "RFC-1271: recompute evidence and compare the committed envelope against a fresh run on non-volatile fields (rfcFileHash, acceptanceHash, probes[].ok, probes.length, overall). Writes nothing; exits 1 on divergence or a missing envelope — detects forged/hand-edited evidence.",
          },
          concurrency: {
            kind: "string",
            description:
              "Bounded parallelism across RFCs for sweep runs (default 1, capped at 16 — invalid values warn and fall back). Probe workers spawn subprocesses.",
          },
          "waive-outcome": {
            kind: "string",
            description:
              "RFC-1453: record an operator outcome-gate waiver ({reason, by}) in emitted envelopes — set by rfc.implement.stamp, not for direct use.",
          },
          "no-batch": {
            kind: "boolean",
            description:
              "RFC-1489: disable test-probe batching — run each probe in its own Vitest process (diagnostic escape).",
          },
          "no-evidence-reuse": {
            kind: "boolean",
            description:
              "RFC-1516: disable the evidence-freshness window — every probe (run/test/page/proof and cheap kinds) re-executes even when the committed green envelope is in-window.",
          },
        },
        execute: runRfcVerificationEmit,
      },
      {
        name: "rfc.verification.refresh",
        modulePath: "packages/forge/os/rfc/rfc.module.ts",
        description:
          "RFC-0999: re-run acceptance probes for implemented RFC(s) and update verification " +
          "evidence envelopes in-place. Preserves emittedAt, adds lastRefreshedAt, replaces " +
          "probes[] with fresh results. Requires --id <rfc-id> or --all. Use --dry-run to " +
          "run probes without writing envelope files.",
        scope: "workspace",
        acceptsAllFlag: true,
        mutatesState: true,
        writes: ["docs/rfcs/verification/*.generated.yaml"],
        // Secondary writer — rfc.verification.emit owns these envelopes;
        // conditional keeps OWN-DUP-01 from flagging the shared glob.
        generates: [
          {
            path: "docs/rfcs/verification/*.generated.yaml",
            phase: "on-demand",
            conditional: true,
          },
        ],
        reads: ["docs/rfcs/**/*.md", "docs/rfcs/verification/*.generated.yaml"],
        cacheable: false,
        flags: {
          id: { kind: "string", description: "Target a single RFC by id (e.g. rfc-0330)." },
          all: {
            kind: "boolean",
            description: "Refresh all implemented RFCs with existing evidence envelopes.",
          },
          "dry-run": {
            kind: "boolean",
            description: "Run probes and report results without writing envelope files.",
          },
          concurrency: {
            kind: "string",
            description:
              "Bounded parallelism across RFCs for sweep runs (default 1, capped at 16 — invalid values warn and fall back). Probe workers spawn subprocesses.",
          },
          "no-batch": {
            kind: "boolean",
            description:
              "RFC-1489: disable test-probe batching — run each probe in its own Vitest process (diagnostic escape).",
          },
        },
        execute: runRfcVerificationRefresh,
      },
      {
        name: "rfc.dna.trace.validate",
        mutatesState: false,
        contract: "rfc",
        rules: [],
        description:
          "RFC-0331: validate the bidirectional DNA-trace matrix — which RFCs satisfy each DNA " +
          "invariant and which invariants each RFC claims to satisfy. Reports DNA-TRACE-01 " +
          "(nonexistent id), DNA-TRACE-02 (uncovered invariant), DNA-TRACE-03 (rejected claim).",
        scope: "workspace",
        flags: {
          dna: {
            kind: "string",
            description: "Filter output to a single DNA invariant (e.g. DNA-35).",
          },
        },
        reads: ["docs/rfcs/**/*.md", "docs/architecture-dna.md"],
        execute: runRfcDnaTraceValidate,
      },
      {
        name: "rfc.dna.trace.generate",
        coverage: "operator" as const,
        modulePath: "packages/forge/os/rfc/rfc.module.ts",
        description:
          "RFC-0331: generate docs/rfcs/dna-trace.generated.yaml — the machine-readable " +
          "requirements-traceability matrix of DNA invariants and satisfying RFCs.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/rfcs/dna-trace.generated.yaml"],
        generates: [{ path: "docs/rfcs/dna-trace.generated.yaml", phase: "on-demand" }],
        reads: ["docs/rfcs/**/*.md", "docs/architecture-dna.md"],
        cacheable: false,
        flags: {},
        execute: runRfcDnaTraceGenerate,
      },
      {
        name: "rfc.decision-log.generate",
        modulePath: "packages/forge/os/rfc/rfc.module.ts",
        description:
          "RFC-0329: generate docs/rfcs/decision-log.generated.yaml and .md aggregating every " +
          "rejected/superseded RFC and every non-empty Alternatives considered section. " +
          "Use --check to verify projections are up to date without writing.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/rfcs/decision-log.generated.yaml", "docs/rfcs/decision-log.generated.md"],
        generates: [
          { path: "docs/rfcs/decision-log.generated.yaml", phase: "on-demand" },
          { path: "docs/rfcs/decision-log.generated.md", phase: "on-demand" },
        ],
        reads: ["docs/rfcs/**/*.md"],
        cacheable: false,
        flags: {
          check: {
            kind: "boolean",
            description: "Drift check only — no writes, exit 1 if projections differ.",
          },
        },
        execute: runRfcDecisionLogGenerate,
      },
      {
        name: "rfc.supersede.propose",
        coverage: "operator" as const,
        description:
          "RFC-0334: escalate a blocked implementation by creating a draft superseding RFC " +
          "with the conflict stated and TODO sections for the proposed alternative.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/rfcs/RFC-*.md"],
        generates: [],
        reads: ["docs/rfcs/**/*.md"],
        cacheable: false,
        flags: {
          id: {
            kind: "string",
            description: "Target RFC id to supersede (e.g. RFC-0322).",
          },
          reason: {
            kind: "string",
            description: "Why the accepted design is unimplementable.",
          },
          invariant: {
            kind: "string",
            description: "Comma-separated invariant ids (DNA-N or RFC-XXXX) that conflict.",
          },
          title: {
            kind: "string",
            description: "Optional replacement title for the new draft.",
          },
        },
        execute: runRfcSupersedePropose,
      },
      {
        name: "rfc.archive",
        coverage: "operator" as const,
        description:
          "Move terminal-status RFC files (implemented, rejected, superseded) into " +
          "docs/rfcs/archive/<status>/ subdirectories. Bidirectional: moves non-terminal " +
          "files found in subdirectories back to root. Use --dry-run to preview. " +
          "Use --status to filter to a single terminal status. " +
          "Prefer the docs.archive umbrella command unless you need to archive only RFCs.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/rfcs/*.md", "docs/rfcs/archive/**"],
        generates: [],
        reads: ["docs/rfcs/**/*.md"],
        cacheable: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            description: "Preview what would be moved without touching the filesystem.",
          },
          status: {
            kind: "string",
            description: "Filter to a single terminal status (implemented, rejected, superseded).",
          },
        },
        execute: runRfcArchive,
      },
      {
        name: "rfc.pipeline.status",
        coverage: "operator" as const,
        mutatesState: false,
        description:
          "Report the pipeline status of RFCs — which steps (audit, enhance, plan, implement) " +
          "are complete or missing. Pass --id to check a single file, or run without " +
          "arguments for all. Read-only — does not mutate files. Skills keep their own " +
          "prerequisite checks; this command is for agents and humans to inspect pipeline state.",
        scope: "workspace",
        flags: {
          id: { kind: "string", description: "Target a single RFC by id (e.g. RFC-0609)." },
        },
        reads: ["docs/rfcs/**/*.md"],
        execute: runRfcPipelineStatus,
      },
      {
        name: "rfc.implement.stamp",
        // gate-completeness: handlers/implement-stamp.ts accumulates
        // violations[] across every independent precondition gate and emits
        // one stampFailResult — the complete set in a single run (RFC-1463).
        compositeGate: true,
        // RFC-1453 outcome waiver records the operator identity from USER/USERNAME.
        envInputs: [
          { name: "USER", required: false },
          { name: "USERNAME", required: false },
        ],
        description:
          "RFC-0476: the exclusive atomic path for accepted → implemented transitions. " +
          "Verifies preconditions (accepted status, checked+evidenced criteria, clean tree, " +
          "reachable RFC-referencing commit, passing probe evidence, fresh evidence hashes — " +
          "RFC-IMP-09 stale-evidence gate from RFC-1271) then atomically sets " +
          "status: implemented, implementedAt, and updatedAt. For probe-bearing RFCs the " +
          "evidence envelope is re-emitted post-mutation so it binds the implemented-state " +
          "file (RFC-1271). Self-repairing by default (RFC-1483): unchecked-but-evidenced " +
          "criteria flip and a missing/stale envelope re-emits inside the same atomic " +
          "write (the RFC-1322 --check-criteria machinery, now the default); --no-repair " +
          "restores fail-fast gating, and unrepairable failures print the ordered " +
          "remediation checklist. Use --dry-run to preview. Required flags: `--id`.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/rfcs/**/*.md", "docs/rfcs/verification/*.generated.yaml"],
        generates: [],
        reads: ["docs/rfcs/**/*.md", "docs/rfcs/verification/*.generated.yaml"],
        cacheable: false,
        flags: {
          "waive-independent-verification": {
            kind: "string",
            description:
              "RFC-1333: operator-only waiver for a non-subagent acceptance report on a verificationTier: high RFC (RFC-IMP-12); the reason is recorded as a stamp warning.",
          },
          "waive-outcome": {
            kind: "string",
            description:
              "RFC-1453: operator-only waiver for the RFC-IMP-14 outcome gate; the reason is recorded in the verification envelope and the stamp commit must carry an X-Outcome-Waiver: trailer. Agents MUST NOT pass it unless the operator directed it.",
          },
          id: {
            kind: "string",
            required: true,
            description: "Target RFC id to stamp (e.g. RFC-0476).",
          },
          "implementation-commit": {
            kind: "string",
            required: false,
            description:
              "SHA of the implementation commit (must be reachable from HEAD and reference the RFC id). " +
              "When omitted, the command auto-detects the commit via git log --grep=<RFC-ID> (RFC-0756).",
          },
          "dry-run": {
            kind: "boolean",
            description: "Perform all checks without mutating the RFC file or emitting evidence.",
          },
          sync: {
            kind: "boolean",
            description:
              "RFC-1306: run the rfc.evidence.sync regeneration chain before the stale-evidence gate instead of failing on RFC-IMP-09. Requires a kernel host (context.invoke).",
          },
          "check-criteria": {
            kind: "boolean",
            description:
              "RFC-1322: auto-check unchecked acceptance criteria whose (evidence: ...) " +
              "annotation resolves (test:/file:/<path>:<line> exists; probe:AC-N passes in " +
              "the evidence envelope), refreshing a missing/stale envelope in-process first. " +
              "Unresolvable annotations abort with STAMP-CHECK-01 before any RFC mutation. " +
              "RFC-1483: retained as an accepted alias — this repair path is the default.",
          },
          "no-repair": {
            kind: "boolean",
            description:
              "RFC-1483: restore the pre-self-repair blocking behavior — no criteria flips, " +
              "no in-process envelope emit; the first prerequisite defect fails the run.",
          },
          "no-evidence-reuse": {
            kind: "boolean",
            description:
              "RFC-1516: forwarded to rfc.evidence.sync and the in-process emit calls — every acceptance probe re-executes even inside the evidence-freshness window.",
          },
        },
        execute: runRfcImplementStamp,
      },
      {
        name: "rfc.evidence.sync",
        coverage: "operator" as const,
        coverageNote:
          "manual/runbook — pre-stamp evidence resync; also invoked by rfc.implement.stamp --sync",
        modulePath: "packages/forge/os/rfc/rfc.module.ts",
        description:
          "RFC-1306: one-command evidence resync before stamp — runs the generated-manifest " +
          "chain in dependency order (checks.commands.generate → command.manifest.generate → " +
          "validator.inventory.generate → docs.commands.generate → ecosystem.manifest.generate), " +
          "then rfc.verification.emit when --id is given. Delegates each step by name through " +
          "the kernel host's invoke port — fails closed (EVIDENCE-SYNC-01) under the standalone " +
          "forge CLI. Stops on the first failing step with its diagnostics verbatim " +
          "(EVIDENCE-SYNC-02). --dry-run lists the steps without executing.",
        scope: "workspace",
        mutatesState: true,
        contract: "rfc",
        rules: [
          { id: "EVIDENCE-SYNC-01", severity: "error" },
          { id: "EVIDENCE-SYNC-02", severity: "error" },
        ],
        flags: {
          id: {
            kind: "string",
            description: "Target a single RFC by id — appends rfc.verification.emit for it.",
          },
          "dry-run": {
            kind: "boolean",
            description: "List the steps without executing (honors context.dryRun, DNA-110).",
          },
          "no-evidence-reuse": {
            kind: "boolean",
            description:
              "RFC-1516: forward to the emit step — every acceptance probe re-executes even when the committed green envelope is inside the evidence-freshness window.",
          },
        },
        reads: ["docs/rfcs/**/*.md"],
        // The artifacts below stay owned by the delegated generators — sync
        // orchestrates them by name, so generates is empty (OWN-DUP-01).
        generates: [],
        writes: [
          "packages/werkstatt-site/src/checks/command-tables/index.generated.ts",
          "docs/command-manifest.generated.yaml",
          "docs/validator-inventory.generated.yaml",
          "docs/COMMANDS.md",
          "docs/ecosystem.generated.yaml",
          "docs/rfcs/verification/*.generated.yaml",
        ],
        cacheable: false,
        execute: runRfcEvidenceSync,
      },
    ],
    pipelines: [],
  };
}
