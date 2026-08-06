/*
<MODULE_CONTRACT>
<purpose>Register the forge spec module — spec.validate (RFC-0394), spec.status + spec.materialize (RFC-0396), spec.live.merge/list/show/validate (RFC-0711).</purpose>
<non-goals>
  <item>Do not implement skill logic — skills live in skills/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0394: initial forgeSpecModule registering spec.validate.</item>
  <item>RFC-0396: added spec.status and spec.materialize commands.</item>
  <item>RFC-0711: added spec.live.merge, spec.live.list, spec.live.show, spec.live.validate commands.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeSpecModule: ForgeModule = {
  name: "forge-spec",
  version: "0.2.0",
  async register(registry) {
    const { runSpecValidate } = await import("./spec-validate.ts");
    const { runSpecStatus } = await import("./spec-status.ts");
    const { runSpecMaterialize } = await import("./spec-materialize.ts");
    const { runSpecLiveMerge } = await import("./live-spec-merge.ts");
    const { runSpecLiveList } = await import("./live-spec-list.ts");
    const { runSpecLiveShow } = await import("./live-spec-show.ts");
    const { runSpecLiveValidate } = await import("./live-spec-validate.ts");

    registry.registerCommand({
      name: "spec.validate",
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
    });

    registry.registerCommand({
      name: "spec.status",
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
    });

    registry.registerCommand({
      name: "spec.materialize",
      description:
        "Scaffold RFC files for the next N front nodes of a spec roadmap. " +
        "Requires --spec=<id>. Optional: --next=<N> (default 8, max 12), --nodes=<id,id> explicit selection.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/rfcs/rfc-*.md", "docs/specs/*/forge-spec.yaml"],
      reads: ["docs/specs/**/*", "docs/rfcs/**/*.md"],
      flags: {
        spec: { kind: "string", required: true, description: "Spec id to materialize from." },
        next: { kind: "string", description: "Number of front nodes to materialize (default 8, max 12)." },
        nodes: { kind: "string", description: "Comma-separated explicit node ids to materialize." },
      },
      execute: runSpecMaterialize,
    });

    registry.registerCommand({
      name: "spec.live.merge",
      description:
        "Merge deltas from an implemented RFC's ## Design section into a living feature spec " +
        "under docs/specs/live/<domain>.md. Requires --id=<RFC-XXXX>. " +
        "Domain is auto-derived from packagesImpacted[0] when liveSpec: true, or uses " +
        "the string value when liveSpec: <domain>. " +
        "All-or-nothing: aborts on any heading conflict without writing. " +
        "Use --dry-run to preview deltas without writing.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/specs/live/*.md"],
      reads: ["docs/rfcs/**/*.md", "docs/specs/live/*.md"],
      flags: {
        id: { kind: "string", required: true, description: "RFC id to merge (e.g. RFC-0711)." },
        "dry-run": { kind: "boolean", description: "Preview deltas without writing files." },
      },
      execute: runSpecLiveMerge,
    });

    registry.registerCommand({
      name: "spec.live.list",
      description:
        "List all living feature specs in docs/specs/live/. " +
        "Returns domain, title, lastMergedRfc, updatedAt, and historyCount for each spec.",
      scope: "workspace",
      reads: ["docs/specs/live/*.md"],
      execute: runSpecLiveList,
    });

    registry.registerCommand({
      name: "spec.live.show",
      description:
        "Show a single living feature spec by domain. " +
        "Requires --domain=<name>. Returns full frontmatter and body content.",
      scope: "workspace",
      reads: ["docs/specs/live/*.md"],
      flags: {
        domain: { kind: "string", required: true, description: "Domain name (filename without .md)." },
      },
      execute: runSpecLiveShow,
    });

    registry.registerCommand({
      name: "spec.live.validate",
      description:
        "Validate all living feature specs in docs/specs/live/. " +
        "Checks V-LS-01 (frontmatter), V-LS-02 (domain/filename match), " +
        "V-LS-03 (lastMergedRfc is archived), V-LS-04 (history entries are archived), " +
        "V-LS-05 (no duplicate domains).",
      scope: "workspace",
      reads: ["docs/specs/live/*.md", "docs/rfcs/**/*.md"],
      execute: runSpecLiveValidate,
    });
  },
};
