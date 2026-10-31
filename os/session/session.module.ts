/*
<MODULE_CONTRACT>
<purpose>Register the session documentation domain commands with the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/*.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: initial forgeSessionModule registering session.save, session.archive, session.validate, session.list commands.</item>
  <item>RFC-1053: register metrics.aggregate command for skill effectiveness metrics aggregation.</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1354: step 4 — CMD-MAN-02 sweep: writes/generates on mutating commands, mutatesState:false on read-only and port/in-memory commands, execOnReadOnly on subprocess commands (0 CMD-MAN-02; 42 ENV-INPUT-02 excluded per Q-1)</item>
  <item>RFC-1471: session.audit Stage-A detectors + audit.report read-model — denied-retry, blocker omission, generated-edit, retry-after-denial, false-claim</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeSessionModule(): Promise<ForgeModule> {
  const { runSessionSave } = await import("./handlers/save.ts");
  const { runSessionArchive } = await import("./handlers/archive.ts");
  const { runSessionValidate } = await import("./handlers/validate.ts");
  const { runSessionList } = await import("./handlers/list.ts");
  const { runMetricsAggregate } = await import("./handlers/metrics-aggregate.ts");
  const { runSessionAudit } = await import("./handlers/session-audit.ts");
  const { runSessionAuditReport } = await import("./handlers/session-audit-report.ts");
  return {
    name: "forge-session",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "session.save",
        description:
          "Convert raw ATIF files from docs/sessions/.raw/ to structured markdown " +
          "in docs/sessions/ with auto-extracted metadata. Idempotent — same raw " +
          "file always produces the same output filename. Deletes raw file after " +
          "conversion unless --keep-raw. Use --raw-file to process a specific file.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/sessions/*.md"],
        generates: [],
        reads: ["docs/sessions/.raw/*"],
        cacheable: false,
        flags: {
          "raw-file": {
            kind: "string",
            description: "Process a specific raw file instead of scanning .raw/.",
          },
          "keep-raw": {
            kind: "boolean",
            description: "Do not delete raw file after conversion.",
          },
          "dry-run": {
            kind: "boolean",
            description: "Preview without writing files.",
          },
        },
        execute: runSessionSave,
      },
      {
        name: "session.archive",
        coverage: "operator" as const,
        description:
          "Move session files older than --max-age-days (default 7) from " +
          "docs/sessions/ to docs/sessions/archive/. Bidirectional: files in " +
          "archive/ younger than threshold are moved back to docs/sessions/. " +
          "Use --dry-run to preview. Age is computed from frontmatter date, " +
          "not filesystem mtime. Prefer the docs.archive umbrella command " +
          "unless you need to archive only sessions.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/sessions/*.md", "docs/sessions/archive/**"],
        generates: [],
        reads: ["docs/sessions/**/*.md"],
        cacheable: false,
        flags: {
          "max-age-days": {
            kind: "string",
            description: "Age threshold in days (default 7).",
          },
          "dry-run": {
            kind: "boolean",
            description: "Preview what would be moved without touching the filesystem.",
          },
        },
        execute: runSessionArchive,
      },
      {
        name: "session.validate",
        coverage: "operator" as const,
        coverageNote: "retrospective session-doc audit — pre-existing frontmatter debt",
        mutatesState: false,
        contract: "session",
        rules: [],
        description:
          "Validate session frontmatter schema (SES-01), id-filename match (SES-02), " +
          "RFC-id existence (SES-03), raw file hygiene (SES-04), and non-markdown " +
          "file detection (SES-05). Pass --id to validate a single file, " +
          "or run without arguments for all. On-demand only — not integrated into " +
          "build.check.",
        scope: "workspace",
        flags: {
          id: { kind: "string", description: "Target a single session by id." },
        },
        reads: ["docs/sessions/**/*.md", "docs/rfcs/**/*.md"],
        execute: runSessionValidate,
      },
      {
        name: "session.list",
        coverage: "operator" as const,
        mutatesState: false,
        description:
          "List all sessions. Filter with --date-from, --date-to, --rfc, --type flags. " +
          "Use --json for machine-readable output. Parses frontmatter on the fly. " +
          "Includes archived sessions (marked with archived: true).",
        scope: "workspace",
        flags: {
          "date-from": {
            kind: "string",
            description: "Filter sessions from this date (YYYY-MM-DD, inclusive).",
          },
          "date-to": {
            kind: "string",
            description: "Filter sessions up to this date (YYYY-MM-DD, inclusive).",
          },
          rfc: {
            kind: "string",
            description: "Filter by related RFC id (e.g. RFC-0537).",
          },
          type: {
            kind: "string",
            description:
              "Filter by session type (mission, grilling, implementation, review, fix, freeform).",
          },
        },
        reads: ["docs/sessions/**/*.md"],
        execute: runSessionList,
      },
      {
        name: "metrics.aggregate",
        coverage: "operator" as const,
        mutatesState: false,
        description:
          "Query and aggregate skill effectiveness metrics from docs/metrics/ files. " +
          "Returns per-skill statistics (invocations, avgFindings, avgFixIterations, avgDurationMs). " +
          "Use --skill to filter by skill name, --since/--until for date range.",
        scope: "workspace",
        flags: {
          skill: {
            kind: "string",
            description: "Filter by skill name (e.g. fo-review).",
          },
          since: {
            kind: "string",
            description: "Only include metrics generated since this date (YYYY-MM-DD).",
          },
          until: {
            kind: "string",
            description: "Only include metrics generated until this date (YYYY-MM-DD).",
          },
        },
        reads: ["docs/metrics/**/*.yaml"],
        execute: runMetricsAggregate,
      },
      {
        name: "session.audit",
        description:
          "RFC-1471: deterministic Stage-A detectors over docs/sessions/*.md — AUDIT-01 denied-retry, AUDIT-02 blocker omission, AUDIT-03 generated-file edit, AUDIT-04 retry-after-denial, AUDIT-05 false completion claim. Writes docs/sessions/audit/<id>.audit.yaml sidecars. Flags: --id, --check.",
        scope: "workspace",
        mutatesState: true,
        writes: ["docs/sessions/audit/*.audit.yaml"],
        generates: [],
        rules: [
          { id: "AUDIT-01", severity: "warning" },
          { id: "AUDIT-02", severity: "error" },
          { id: "AUDIT-03", severity: "error" },
          { id: "AUDIT-04", severity: "error" },
          { id: "AUDIT-05", severity: "warning" },
        ],
        coverage: "operator" as const,
        flags: {
          id: { kind: "string", description: "Audit a single session by id fragment." },
          check: { kind: "boolean", description: "Exit non-zero on any error-severity finding." },
        },
        reads: ["docs/sessions/*.md"],
        execute: runSessionAudit,
      },
      {
        name: "session.audit.report",
        coverage: "operator" as const,
        description:
          "RFC-1471: read-model over docs/sessions/audit/*.audit.yaml — per-rule frequency, verdict distribution, and finding classes with no friction on file.",
        scope: "workspace",
        mutatesState: false,
        flags: {},
        reads: ["docs/sessions/audit/*.audit.yaml", "docs/frictions.yaml"],
        execute: runSessionAuditReport,
      },
    ],
    pipelines: [],
  };
}
