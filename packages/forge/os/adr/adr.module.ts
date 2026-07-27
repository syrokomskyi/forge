/*
<MODULE_CONTRACT>
<purpose>Register the Architectural Decision Record (ADR) command domain with the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement command logic here; implementations live in handlers/*.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0366: register adr.create, adr.validate, and adr.list commands.</item>
  <item>RFC-0521: migrated from packages/os/site-kernel/src/adr/ to packages/forge/os/adr/ as forgeAdrModule.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeAdrModule: ForgeModule = {
  name: "forge-adr",
  version: "0.1.0",

  async register(registry) {
    const { runAdrList, runAdrCreate } = await import("./handlers/list-create.ts");
    const { runAdrValidate } = await import("./handlers/validate.ts");
    const { runAdrArchive } = await import("./handlers/archive.ts");

    registry.registerCommand({
      name: "adr.list",
      description:
        "List all ADRs. Filter with --status, --scope, --decider flags. " +
        "Use --json for machine-readable output. " +
        "Parses frontmatter on the fly — no index file needed.",
      scope: "workspace",
      flags: {
        status: {
          kind: "string",
          description: "Filter by ADR status (e.g. proposed, accepted, superseded).",
        },
        scope: {
          kind: "string",
          description: "Filter by ADR scope (package, app, workspace).",
        },
        decider: { kind: "string", description: "Filter by decider string." },
      },
      reads: ["docs/adrs/**/*.md"],
      execute: runAdrList,
    });

    registry.registerCommand({
      name: "adr.create",
      description:
        "Create a new ADR draft from the template. " +
        'Pass --title "Short title" (required). ' +
        "Optional: --scope, --decider, --status, --related. " +
        "Always creates status: proposed unless overridden. " +
        "AI agents are allowed to use this command.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/adrs/adr-*.md"],
      reads: ["docs/adrs/**/*.md"],
      cacheable: false,
      flags: {
        title: { kind: "string", required: true, description: "Short imperative ADR title." },
        scope: {
          kind: "string",
          default: "package",
          description: "ADR scope: package | app | workspace.",
        },
        decider: {
          kind: "string",
          default: "architecture",
          description: "ADR decider, e.g. architecture or human:<handle>.",
        },
        status: {
          kind: "string",
          default: "proposed",
          description: "ADR status: proposed | accepted | superseded | rejected.",
        },
        related: {
          kind: "string",
          description: "Comma-separated list of related RFC/ADR ids (e.g. RFC-0365,RFC-0001).",
        },
      },
      execute: runAdrCreate,
    });

    registry.registerCommand({
      name: "adr.validate",
      description:
        "Validate ADR frontmatter schema, required markdown sections, " +
        "referential integrity (supersedes/supersededBy), and id/filename consistency. " +
        "Pass an ADR id to validate a single file, or run without arguments for all.",
      scope: "workspace",
      flags: {},
      reads: ["docs/adrs/**/*.md"],
      execute: runAdrValidate,
    });

    registry.registerCommand({
      name: "adr.archive",
      description:
        "Move terminal-status ADR files (implemented, rejected, superseded) into " +
        "docs/adrs/archive/<status>/ subdirectories. Bidirectional: moves non-terminal " +
        "files found in subdirectories back to root. Use --dry-run to preview. " +
        "Use --status to filter to a single terminal status. " +
        "Prefer the docs.archive umbrella command unless you need to archive only ADRs.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/adrs/*.md", "docs/adrs/archive/**"],
      reads: ["docs/adrs/**/*.md"],
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
      execute: runAdrArchive,
    });
  },
};
