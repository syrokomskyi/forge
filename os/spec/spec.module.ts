/*
<MODULE_CONTRACT>
<purpose>Register the forge spec module — spec.validate (RFC-0394), spec.status + spec.materialize (RFC-0396), spec.live.merge/list/show/validate (RFC-0711).</purpose>
<non-goals>
  <item>Do not implement skill logic — skills live in skills/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1230: added spec.live.rebuild command + --force flag on spec.live.merge (idempotent merge design).</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
  <item>RFC-1231: step 1 — rename supportsAllSites to acceptsAllFlag

Mechanical sweep: the field only ever gated --all argv acceptance; fan-out
follows the parsed selector. Guard renamed assertAllSitesAllowed ->
assertAllFlagAccepted, message updated. 417 declaration sites + type
surfaces (KernelCommandMetadata, ForgeCommandMetadata) in one atomic pass.</item>
  <item>RFC-1234: add V-LS-09 content-drift gate to spec.live.validate (RFC-1234)

Extract projectLiveSpec — the pure replay projection — from rebuildOneSpec so the validator reuses the same dedupe + Design replay + serialize pipeline rebuild writes. spec.live.validate emits V-LS-09 error when committed bytes diverge from the projection modulo updatedAt, and a warning-severity diagnostic for history RFCs unreadable during replay. LivingSpecViolation gains severity field (absent = error; errors drive exit code). uniqueRfcs contract comment states the deduplicated-history semantics exactly.

Severity decision per RFC rollout: error on introduction — the pre-flight reconciliation rebuild left a verified-clean baseline.</item>
  <history>RFC-0394, RFC-0396, RFC-0711</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeSpecModule(): Promise<ForgeModule> {
const { runSpecValidate } = await import("./spec-validate.ts");
    const { runSpecStatus } = await import("./spec-status.ts");
    const { runSpecMaterialize } = await import("./spec-materialize.ts");
    const { runSpecLiveMerge } = await import("./live-spec-merge.ts");
    const { runSpecLiveList } = await import("./live-spec-list.ts");
    const { runSpecLiveShow } = await import("./live-spec-show.ts");
    const { runSpecLiveValidate } = await import("./live-spec-validate.ts");
    const { runSpecLiveRebuild } = await import("./live-spec-rebuild.ts");
  return {
  name: "forge-spec",
  version: "0.2.0",
  runtime: "autonomous",
    declarations: [],
  commands: [
    {
      name: "spec.validate",
      mutatesState: false,
      contract: "spec",
      rules: [],
      description:
        "Validate vendored spec packages under docs/specs/. " +
        "Checks integrity (SHA-256), schema, dependency graph (acyclic), " +
        "reference resolution, wave coverage, duplicate ids, and materializedAs links. " +
        "Use --spec=<id> to validate a single spec.",
      scope: "workspace",
      flags: {
        spec: {
          kind: "string",
          description: "Validate only the named spec.",
        },
      },
      reads: ["docs/specs/**/*"],
      execute: runSpecValidate,
    },
    {
      name: "spec.status",
      mutatesState: false,
      description:
        "Show roadmap progress for vendored specs. " +
        "Without --spec, summarizes all specs; with it, full per-node table + computed front.",
      scope: "workspace",
      flags: {
        spec: {
          kind: "string",
          description: "Show status for a single spec.",
        },
      },
      reads: ["docs/specs/**/*", "docs/rfcs/**/*.md"],
      execute: runSpecStatus,
    },
    {
      name: "spec.materialize",
      description:
        "Scaffold RFC files for the next N front nodes of a spec roadmap. " +
        "Requires --spec=<id>. Optional: --next=<N> (default 8, max 12), --nodes=<id,id> explicit selection.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/rfcs/rfc-*.md", "docs/specs/*/forge-spec.yaml"],
      generates: [],
      reads: ["docs/specs/**/*", "docs/rfcs/**/*.md"],
      flags: {
        spec: { kind: "string", required: true, description: "Spec id to materialize from." },
        next: { kind: "string", description: "Number of front nodes to materialize (default 8, max 12)." },
        nodes: { kind: "string", description: "Comma-separated explicit node ids to materialize." },
      },
      execute: runSpecMaterialize,
    },
    {
      name: "spec.live.merge",
      description:
        "Merge deltas from an implemented RFC's ## Design section into a living feature spec " +
        "under docs/specs/live/<domain>.md. Requires --id=<RFC-XXXX>. " +
        "Domain is auto-derived from packagesImpacted[0] when liveSpec: true, or uses " +
        "the string value when liveSpec: <domain>. " +
        "Idempotent: an RFC already in spec history[] is skipped as already-merged; " +
        "use --force to re-merge (replaces that RFC's namespaced sections). " +
        "Use --dry-run to preview deltas without writing.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/specs/live/*.md"],
      generates: [],
      reads: ["docs/rfcs/**/*.md", "docs/specs/live/*.md"],
      flags: {
        id: { kind: "string", required: true, description: "RFC id to merge (e.g. RFC-0711)." },
        force: { kind: "boolean", description: "Re-merge an already-merged RFC — strips its (RFC-XXXX) sections and old history entries first." },
        "dry-run": { kind: "boolean", description: "Preview deltas without writing files." },
      },
      execute: runSpecLiveMerge,
    },
    {
      name: "spec.live.list",
      mutatesState: false,
      description:
        "List all living feature specs in docs/specs/live/. " +
        "Returns domain, title, lastMergedRfc, updatedAt, and historyCount for each spec.",
      scope: "workspace",
      flags: {},
      reads: ["docs/specs/live/*.md"],
      execute: runSpecLiveList,
    },
    {
      name: "spec.live.show",
      mutatesState: false,
      description:
        "Show a single living feature spec by domain. " +
        "Requires --domain=<name>. Returns full frontmatter and body content.",
      scope: "workspace",
      reads: ["docs/specs/live/*.md"],
      flags: {
        domain: { kind: "string", required: true, description: "Domain name (filename without .md)." },
      },
      execute: runSpecLiveShow,
    },
    {
      name: "spec.live.validate",
      mutatesState: false,
      contract: "spec",
      rules: [],
      description:
        "Validate all living feature specs in docs/specs/live/. " +
        "Checks V-LS-01 (frontmatter), V-LS-02 (domain/filename match), " +
        "V-LS-03 (lastMergedRfc is archived), V-LS-04 (history entries are archived), " +
        "V-LS-05 (no duplicate domains), V-LS-06 (no duplicate RFC-namespaced headings), " +
        "V-LS-07 (no duplicate history RFCs), V-LS-08 (merged-history coverage is complete), " +
        "V-LS-09 (spec content matches the deterministic replay of its history). " +
        "Repair path: spec.live.rebuild.",
      scope: "workspace",
      flags: {},
      reads: ["docs/specs/live/*.md", "docs/rfcs/**/*.md"],
      execute: runSpecLiveValidate,
    },
    {
      name: "spec.live.rebuild",
      acceptsAllFlag: true,
      description:
        "Rebuild a living feature spec by replaying its deduplicated history[] — " +
        "the repair path for duplicated (RFC-XXXX) sections and duplicate history entries " +
        "reported by spec.live.validate (V-LS-06/V-LS-07). " +
        "Each unique RFC's current ## Design is re-applied in first-occurrence order; " +
        "unreadable or unimplemented RFCs are skipped with a warning. " +
        "With no --domain (or --all) every spec is rebuilt. Use --dry-run to preview.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/specs/live/*.md"],
      generates: [],
      reads: ["docs/specs/live/*.md", "docs/rfcs/**/*.md"],
      flags: {
        domain: { kind: "string", description: "Rebuild a single living spec by domain (filename without .md)." },
        all: { kind: "boolean", description: "Rebuild every living spec in docs/specs/live/ (default when --domain is omitted)." },
        "dry-run": { kind: "boolean", description: "Preview rebuild without writing files." },
      },
      execute: runSpecLiveRebuild,
    }
  ],
  pipelines: [

  ]};
}
;
