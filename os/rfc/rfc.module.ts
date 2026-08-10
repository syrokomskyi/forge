/*
<MODULE_CONTRACT>
<purpose>Facilitates the registration and execution of commands related to RFC management within the workspace.</purpose>
<non-goals>
  <item>Do not manage RFC storage or persistence mechanisms.</item>
  <item>Do not handle user interface concerns or command-line parsing.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0260: declare typed `flags` schemas for the whole rfc.* command family; unknown/malformed flags now fail with KERNEL-FLAG-01/02/03 instead of being silently ignored.</item>
  <item>Post-refactor hardening: expose `rfc.create --satisfies` for explicit DNA trace scaffolding.</item>
  <item>RFC-0795: add `--batch` flag to `rfc.list` for filtering by batch slug.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeRfcModule: ForgeModule = {
  name: "rfc",
  version: "0.1.0",

  async register(registry) {
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
    const { runRfcDnaTraceValidate, runRfcDnaTraceGenerate } = await import("./dna-trace.ts");
    const { runRfcDecisionLogGenerate } = await import("./decision-log.ts");
    const { runRfcSupersedePropose } = await import("./handlers/supersede-propose.ts");
    const { runRfcArchive } = await import("./handlers/archive.ts");
    const { runRfcPipelineStatus } = await import("./handlers/pipeline-status.ts");
    const { runRfcImplementStamp } = await import("./handlers/implement-stamp.ts");
    // ── rfc.list ─────────────────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.list",
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
    });

    // ── rfc.create ───────────────────────────────────────────────────────────
    registry.registerCommand({
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
        scope: { kind: "string", default: "workspace", description: "RFC scope: app | workspace." },
        satisfies: {
          kind: "string",
          description:
            "Comma-separated DNA ids this RFC satisfies. Required for architecture/contract RFCs.",
        },
      },
      execute: runRfcCreate,
    });

    // ── rfc.next-id ───────────────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.next-id",
      description:
        "Return the next free RFC number (max existing + 1) by scanning docs/rfcs/ recursively including archive/.",
      scope: "workspace",
      flags: {},
      reads: ["docs/rfcs/**/*.md"],
      execute: runRfcNextId,
    });

    // ── rfc.validate ─────────────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.validate",
      description:
        "Validate RFC frontmatter schema, required markdown sections, " +
        "referential integrity (supersedes/supersededBy), date consistency, " +
        "and RFC command lifecycle metadata (RFC-CMD-*). " +
        "Pass --id to validate a single file, or run without arguments for all.",
      scope: "workspace",
      flags: {
        id: { kind: "string", description: "Target a single RFC by id (e.g. RFC-0609)." },
      },
      reads: ["docs/rfcs/**/*.md"],
      execute: runRfcValidate,
    });

    // ── rfc.command-lifecycle.validate ───────────────────────────────────────
    registry.registerCommand({
      name: "rfc.command-lifecycle.validate",
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
    });

    // ── rfc.check ────────────────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.check",
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
    });

    // ── rfc.index.generate ───────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.index.generate",
      description:
        "Emit a machine-readable relationship index of all RFCs (id, status, dates, " +
        "supersedes/supersededBy/amends/amendedBy/related). Use --json, or --write to " +
        "persist docs/rfcs/index.yaml.",
      scope: "workspace",
      // RFC-0260: typed flag schema.
      flags: {
        write: {
          kind: "boolean",
          description: "Persist the generated index to docs/rfcs/index.yaml.",
        },
      },
      reads: ["docs/rfcs/**/*.md"],
      cacheable: false,
      execute: runRfcIndexGenerate,
    });

    // ── rfc.index.validate ───────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.index.validate",
      description:
        "Validate that docs/rfcs/index.yaml exists, is parseable, and its entry count " +
        "matches the number of RFC files on disk. Reports RFC-IDX-01 (missing), " +
        "RFC-IDX-02 (unparseable), RFC-IDX-03 (count mismatch).",
      scope: "workspace",
      flags: {},
      reads: ["docs/rfcs/**/*.md", "docs/rfcs/index.yaml"],
      execute: runRfcIndexValidate,
    });

    // ── rfc.graph ────────────────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.graph",
      description:
        "Print one RFC's relationship neighbours (supersedes/supersededBy/amends/" +
        "amendedBy/related). Pass --id RFC-0152.",
      scope: "workspace",
      flags: {
        id: { kind: "string", description: "Target a single RFC by id (e.g. RFC-0152)." },
      },
      reads: ["docs/rfcs/**/*.md"],
      execute: runRfcGraph,
    });

    // ── rfc.acceptance.run ───────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.acceptance.run",
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
      },
      reads: ["docs/rfcs/**/*.md"],
      cacheable: false,
      execute: runRfcAcceptanceRun,
    });

    // ── rfc.verification.emit ────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.verification.emit",
      description:
        "RFC-0330: execute acceptance probes for target RFC(s) and write per-RFC verification " +
        "evidence artifacts to docs/rfcs/verification/*.generated.yaml. Requires --id <rfc-id> " +
        "or --status <status>. Reuses runProbe from RFC-0268. Writes via writeFileAtomic.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/rfcs/verification/*.generated.yaml"],
      reads: ["docs/rfcs/**/*.md"],
      cacheable: false,
      flags: {
        id: { kind: "string", description: "Target a single RFC by id (e.g. rfc-0330)." },
        status: {
          kind: "string",
          description: "Target every RFC with this status (e.g. implemented).",
        },
      },
      execute: runRfcVerificationEmit,
    });

    // ── rfc.dna.trace.validate ───────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.dna.trace.validate",
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
    });

    // ── rfc.dna.trace.generate ───────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.dna.trace.generate",
      description:
        "RFC-0331: generate docs/rfcs/dna-trace.generated.yaml — the machine-readable " +
        "requirements-traceability matrix of DNA invariants and satisfying RFCs.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/rfcs/dna-trace.generated.yaml"],
      reads: ["docs/rfcs/**/*.md", "docs/architecture-dna.md"],
      cacheable: false,
      flags: {},
      execute: runRfcDnaTraceGenerate,
    });

    // ── rfc.decision-log.generate ────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.decision-log.generate",
      description:
        "RFC-0329: generate docs/rfcs/decision-log.generated.yaml and .md aggregating every " +
        "rejected/superseded RFC and every non-empty Alternatives considered section. " +
        "Use --check to verify projections are up to date without writing.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/rfcs/decision-log.generated.yaml", "docs/rfcs/decision-log.generated.md"],
      reads: ["docs/rfcs/**/*.md"],
      cacheable: false,
      flags: {
        check: {
          kind: "boolean",
          description: "Drift check only — no writes, exit 1 if projections differ.",
        },
      },
      execute: runRfcDecisionLogGenerate,
    });

    // ── rfc.supersede.propose ─────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.supersede.propose",
      description:
        "RFC-0334: escalate a blocked implementation by creating a draft superseding RFC " +
        "with the conflict stated and TODO sections for the proposed alternative.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/rfcs/RFC-*.md"],
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
    });

    // ── rfc.archive ───────────────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.archive",
      description:
        "Move terminal-status RFC files (implemented, rejected, superseded) into " +
        "docs/rfcs/archive/<status>/ subdirectories. Bidirectional: moves non-terminal " +
        "files found in subdirectories back to root. Use --dry-run to preview. " +
        "Use --status to filter to a single terminal status. " +
        "Prefer the docs.archive umbrella command unless you need to archive only RFCs.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/rfcs/*.md", "docs/rfcs/archive/**"],
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
    });

    // ── rfc.pipeline.status ──────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.pipeline.status",
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
    });

    // ── rfc.implement.stamp ──────────────────────────────────────────────────
    registry.registerCommand({
      name: "rfc.implement.stamp",
      description:
        "RFC-0476: the exclusive atomic path for accepted → implemented transitions. " +
        "Verifies preconditions (accepted status, checked+evidenced criteria, clean tree, " +
        "reachable RFC-referencing commit, passing probe evidence) then atomically sets " +
        "status: implemented, implementedAt, and updatedAt. Use --dry-run to preview.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/rfcs/**/*.md"],
      reads: ["docs/rfcs/**/*.md", "docs/rfcs/verification/*.generated.yaml"],
      cacheable: false,
      flags: {
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
      },
      execute: runRfcImplementStamp,
    });
  },
};
