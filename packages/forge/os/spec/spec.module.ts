/*
<MODULE_CONTRACT>
<purpose>Register the forge spec module — spec.validate (RFC-0394), spec.status + spec.materialize (RFC-0396).</purpose>
<non-goals>
  <item>Do not implement skill logic — skills live in skills/.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0394: initial forgeSpecModule registering spec.validate.</item>
  <item>RFC-0396: added spec.status and spec.materialize commands.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeSpecModule: ForgeModule = {
  name: "forge-spec",
  version: "0.1.0",
  async register(registry) {
    const { runSpecValidate } = await import("./spec-validate.ts");
    const { runSpecStatus } = await import("./spec-status.ts");
    const { runSpecMaterialize } = await import("./spec-materialize.ts");

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
  },
};
