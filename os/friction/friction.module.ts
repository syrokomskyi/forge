/*
<MODULE_CONTRACT>
<purpose>Register the friction.validate command with the forge kernel registry (RFC-1433).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/friction-validate.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1590: store append-only shared ledgers as one file per record</item>
  <item>RFC-1601: ledger writers assign + refusals teach the violated rule (RFC-1601)

FRICTION-11 flags any out-of-vocabulary friction field value at validate, naming field+value+closed set — the mechanical detector for hand-edit corruption (F-0206/F-0244). queue.decision is the new decision-ledger writer: schema-gated append stamping createdAt/answeredAt, next-free Q-id default, QUEUE-05/QUEUE-DEC-01 refusals carrying the minimal shape. ecosystem.commit --rfc/--adr normalize bare digits or refuse EC-35 with the format statement — the F-0248 silent-injection-skip class is closed, and a summary-record failure now names the id + skipped injection. RFC-IMP-10 refusal leads with the rule statement; pipeline conventions and guides point at the command write path.</item>
  <item>RFC-1592: retire 3 unprobeable rules (F-0288 recurrence) unblocking this worktree's RFC-1592 ratchet</item>
  <item>RFC-1639: step 3-4 — friction.migrate --from ingest, friction.add --level, CREATE-SUPERFOLDER-01 guard</item>
  <item>RFC-1639: review — SYSTEM-MAP-01 rules decl, git-probe warnings, sibling kind/path discriminants, friction.add provenance, ingest hardening</item>
  <history>RFC-1433, RFC-1460, RFC-1461</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

import { FRICTION_DIR, LEGACY_FRICTION_FILE } from "./store.ts";

export async function createForgeFrictionModule(): Promise<ForgeModule> {
  const { runFrictionValidate } = await import("./handlers/friction-validate.ts");
  const { runFrictionAdd } = await import("./handlers/friction-add.ts");
  const { runFrictionMigrate } = await import("./handlers/friction-migrate.ts");
  return {
    name: "forge-friction",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "friction.validate",
        description:
          "Validate the friction registry — per-record files under " +
          `${FRICTION_DIR}/ plus the legacy single-file registry while ` +
          "it still exists. FRICTION-01 fails on unreadable/unparseable " +
          "files, entry-shape violations, malformed or duplicate ids, and " +
          "record files whose name does not match their id; FRICTION-02 " +
          "on categories outside the closed catalog; FRICTION-03 on bad " +
          "status or addressed entries without artifacts; FRICTION-04 on " +
          "lastSeen before created or negative recurrences; FRICTION-05 " +
          "warns on empty/non-normalized signatures and unresolvable " +
          "artifact paths; FRICTION-06 fails on addressed entries whose " +
          "signature recurred twice on a docs-only measure; FRICTION-07 " +
          "warns on addressed entries with no measureKind; FRICTION-08 " +
          "fails on escalated entries whose measure names no mechanical " +
          "obligation; FRICTION-09 fails on an id present in both the " +
          "directory and the legacy file; FRICTION-10 warns while a " +
          "legacy file with records exists and names friction.migrate; " +
          "FRICTION-11 fails on any field value outside its declared " +
          "vocabulary, naming field + value + the closed set (RFC-1601). " +
          "An absent registry passes with entries: 0 — records are " +
          "created by friction.add. Read-only.",
        scope: "workspace",
        contract: "frictions",
        rules: [
          { id: "FRICTION-01", severity: "error" },
          { id: "FRICTION-02", severity: "error" },
          { id: "FRICTION-03", severity: "error" },
          { id: "FRICTION-04", severity: "error" },
          { id: "FRICTION-05", severity: "warning" },
          { id: "FRICTION-06", severity: "error" },
          { id: "FRICTION-07", severity: "warning" },
          { id: "FRICTION-08", severity: "error" },
          { id: "FRICTION-09", severity: "error" },
          { id: "FRICTION-10", severity: "warning" },
        ],
        mutatesState: false,
        execOnReadOnly: true,
        reads: [`${FRICTION_DIR}/**`, LEGACY_FRICTION_FILE],
        cacheable: false,
        flags: {},
        execute: runFrictionValidate,
      },
      {
        name: "friction.add",
        description:
          "RFC-1590: the only write path for friction records. Allocates " +
          "the next F-NNNN id on the shared governance-reservation " +
          "surface (safe under concurrent session worktrees), validates " +
          "the record against the friction.validate vocabulary BEFORE " +
          "any file lands, and writes " +
          `${FRICTION_DIR}/F-NNNN.yaml. --recurrence-of <F-NNNN> writes ` +
          "no new file — it increments recurrences and sets lastSeen on " +
          "the named per-record file.",
        scope: "workspace",
        contract: "frictions",
        rules: [
          { id: "FRICTION-01", severity: "error" },
          { id: "FRICTION-02", severity: "error" },
          { id: "FRICTION-03", severity: "error" },
          { id: "FRICTION-05", severity: "error" },
          { id: "FRICTION-ADD-01", severity: "error" },
          { id: "FRICTION-ADD-02", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        reads: [`${FRICTION_DIR}/**`, LEGACY_FRICTION_FILE],
        writes: [`${FRICTION_DIR}/**`],
        generates: [],
        flags: {
          category: {
            kind: "string",
            required: false,
            description: "Friction category (tooling, docs, process, environment, self).",
          },
          signature: {
            kind: "string",
            required: false,
            description: "Short lowercase signature used for recurrence matching.",
          },
          friction: {
            kind: "string",
            required: false,
            description: "What happened — the observed friction narrative.",
          },
          measure: {
            kind: "string",
            required: false,
            description: "What prevents it — the measure taken or planned.",
          },
          "measure-kind": {
            kind: "string",
            required: false,
            description:
              "Measure class (docs-rule, skill-step, validator, code-change, flag-default, pipeline, external).",
          },
          status: {
            kind: "string",
            required: false,
            description: "Record status (open, addressed, escalated) — default open.",
          },
          session: {
            kind: "string",
            required: false,
            description:
              "Session id to attribute the record to — defaults to the current branch name.",
          },
          artifacts: {
            kind: "string",
            required: false,
            description: "Comma-separated artifact paths the measure landed in.",
          },
          "recurrence-of": {
            kind: "string",
            required: false,
            description:
              "Existing record id — increments recurrences and sets lastSeen instead of writing a new record.",
          },
          level: {
            kind: "string",
            required: false,
            description:
              "Record level: repo (default — omitted) or folder (RFC-1639 — the record concerns the superfolder, not this repo).",
          },
        },
        execute: runFrictionAdd,
      },
      {
        name: "friction.migrate",
        description:
          "RFC-1590: split the legacy single-file registry into per-record " +
          `files under ${FRICTION_DIR}/, remove the legacy file in the ` +
          "same run, and move every .agents/skills/*/qa-log.md to " +
          "qa-log/legacy.md. Idempotent — with no legacy file and no " +
          "qa-log.md files it reports migrated: 0. RFC-1639: --from " +
          "<external frictions.yaml> ingests a registry from outside the " +
          "workspace (ledger-minted ids, migratedFrom/origin/level provenance).",
        scope: "workspace",
        contract: "frictions",
        rules: [
          { id: "FRICTION-01", severity: "error" },
          { id: "FRICTION-03", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        reads: [`${FRICTION_DIR}/**`, LEGACY_FRICTION_FILE, ".agents/skills/**"],
        writes: [`${FRICTION_DIR}/**`, LEGACY_FRICTION_FILE, ".agents/skills/**"],
        generates: [],
        flags: {
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Report the split and shard moves without writing.",
          },
          from: {
            kind: "string",
            required: false,
            description:
              "RFC-1639: ingest an EXTERNAL legacy frictions.yaml — records mint at the next F-ids via the shared ledger with migratedFrom+origin provenance; the source file is removed last. Must point outside the workspace.",
          },
          level: {
            kind: "string",
            required: false,
            description: "Level stamped on --from-ingested records: folder (default) or repo.",
          },
          session: {
            kind: "string",
            required: false,
            description:
              "Session id to attribute the --from ledger allocation to — defaults to the current branch name.",
          },
        },
        execute: runFrictionMigrate,
      },
    ],
    pipelines: [],
  };
}
