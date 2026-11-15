/*
<MODULE_CONTRACT>
<purpose>Register the queue.validate command with the forge kernel registry (RFC-1140).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/queue-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1350: review follow-ups — QUEUE-09 touched-set edge cases (empty window, quoted paths, rename source, malformed entries), strict baseline, manifest template/scope wording, generated artifacts resync</item>
  <item>RFC-1354: step 4 — CMD-MAN-02 sweep: writes/generates on mutating commands, mutatesState:false on read-only and port/in-memory commands, execOnReadOnly on subprocess commands (0 CMD-MAN-02; 42 ENV-INPUT-02 excluded per Q-1)</item>
  <item>RFC-1461: declare rules[] severity via CommandRuleDecl workspace-wide (RFC-1461)</item>
  <item>RFC-1601: ledger writers assign + refusals teach the violated rule (RFC-1601)

FRICTION-11 flags any out-of-vocabulary friction field value at validate, naming field+value+closed set — the mechanical detector for hand-edit corruption (F-0206/F-0244). queue.decision is the new decision-ledger writer: schema-gated append stamping createdAt/answeredAt, next-free Q-id default, QUEUE-05/QUEUE-DEC-01 refusals carrying the minimal shape. ecosystem.commit --rfc/--adr normalize bare digits or refuse EC-35 with the format statement — the F-0248 silent-injection-skip class is closed, and a summary-record failure now names the id + skipped injection. RFC-IMP-10 refusal leads with the rule statement; pipeline conventions and guides point at the command write path.</item>
  <item>RFC-1592: retire 3 unprobeable rules (F-0288 recurrence) unblocking this worktree's RFC-1592 ratchet</item>
  <history>RFC-1140, RFC-1250, RFC-1350</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeQueueModule(): Promise<ForgeModule> {
  const { runQueueValidate } = await import("./handlers/queue-validate.ts");
  const { runQueueDecision } = await import("./handlers/queue-decision.ts");
  return {
    name: "forge-queue",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "queue.decision",
        description:
          "Append one schema-validated entry to a queue manifest's decision " +
          "ledger (docs/queues/<stem>.decisions.yaml) — the documented write " +
          "path (RFC-1601). The writer stamps the ledger's createdAt on " +
          "first write and the entry's answeredAt when status is answered or " +
          "auto-resolved; --id defaults to the next free Q-id. Refuses " +
          "QUEUE-01 on an unreadable manifest/ledger, QUEUE-05 on a " +
          "duplicate decision id (names the next free id), QUEUE-DEC-01 on " +
          "input/schema violations with the minimal satisfying shape. " +
          "Required flags: `--file` plus the entry fields (--doc/--stage/" +
          "--question) or --entry-file for a full entry object.",
        scope: "workspace",
        contract: "queue",
        rules: [
          { id: "QUEUE-01", severity: "error" },
          { id: "QUEUE-05", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        reads: ["docs/queues/*.yaml"],
        writes: ["docs/queues/*.decisions.yaml"],
        generates: [],
        flags: {
          file: {
            kind: "string",
            required: true,
            description:
              "Path to the queue manifest YAML file — the ledger is its sibling <stem>.decisions.yaml.",
          },
          "entry-file": {
            kind: "string",
            required: false,
            description:
              "Path to a YAML/JSON file holding the full decision entry object (options passthrough).",
          },
          id: {
            kind: "string",
            required: false,
            description: "Decision id (Q-N) — defaults to the next free id in the ledger.",
          },
          doc: {
            kind: "string",
            required: false,
            description: "Target document id (RFC-NNNN or ADR-NNNN).",
          },
          stage: {
            kind: "string",
            required: false,
            description: "Pipeline stage: idea|audit|enhance|plan|implement|review.",
          },
          question: {
            kind: "string",
            required: false,
            description: "The decision question.",
          },
          "resolution-path": {
            kind: "string",
            required: false,
            description:
              "How the question resolves: codebase|convention|profile|policy|none (default none).",
          },
          status: {
            kind: "string",
            required: false,
            description: "Entry status: open|answered|auto-resolved|deferred (default open).",
          },
          answer: {
            kind: "string",
            required: false,
            description: "The recorded answer (required for answered/auto-resolved entries).",
          },
        },
        execute: runQueueDecision,
      },
      {
        name: "queue.validate",
        description:
          "Validate a queue manifest (docs/queues/*.yaml) and its decision " +
          "ledger sibling, report derived per-item pipeline status plus the " +
          "next actionable item. QUEUE-07 blocks implementable items carrying " +
          "un-parked open decisions (RFC-1250); QUEUE-08 warns on ledger " +
          "hygiene issues (missing answers, foreign doc ids); QUEUE-09 warns " +
          "when the manifest's packagesImpacted is absent, names a non-root " +
          "entry, or names roots with no touched files since the introduction " +
          "commit while other roots are touched (RFC-1350). " +
          "Read-only — " +
          "the pipeline orchestrator runs this before a queued batch and the " +
          "decision window consumes its diagnostics (RFC-1140). " +
          "Required flags: `--file`.",
        scope: "workspace",
        contract: "queue",
        rules: [
          { id: "QUEUE-01", severity: "error" },
          { id: "QUEUE-02", severity: "error" },
          { id: "QUEUE-03", severity: "error" },
          { id: "QUEUE-04", severity: "error" },
          { id: "QUEUE-05", severity: "error" },
          { id: "QUEUE-06", severity: "error" },
          { id: "QUEUE-07", severity: "error" },
          { id: "QUEUE-08", severity: "error" },
          { id: "QUEUE-09", severity: "warning" },
        ],
        mutatesState: false,
        execOnReadOnly: true,
        reads: [
          "docs/queues/*.yaml",
          "docs/rfcs/**/*.md",
          "docs/adrs/**/*.md",
          "docs/audits/*.md",
          "docs/plans/*.md",
        ],
        cacheable: false,
        flags: {
          file: {
            kind: "string",
            required: true,
            description: "Path to the queue manifest YAML file.",
          },
        },
        execute: runQueueValidate,
      },
    ],
    pipelines: [],
  };
}
