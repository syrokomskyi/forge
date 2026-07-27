/*
<MODULE_CONTRACT>
<purpose>Register the plan archive command with the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/archive.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: initial forgePlanModule registering plan.archive command.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgePlanModule: ForgeModule = {
  name: "forge-plan",
  version: "0.1.0",
  async register(registry) {
    const { runPlanArchive } = await import("./handlers/archive.ts");

    registry.registerCommand({
      name: "plan.archive",
      description:
        "Move plan files whose parent RFC has terminal status " +
        "(implemented, rejected, superseded) into docs/plans/archive/<status>/ " +
        "subdirectories. Bidirectional: moves non-terminal files found in " +
        "subdirectories back to root. Use --dry-run to preview. " +
        "Use --status to filter to a single terminal status. " +
        "Prefer the docs.archive umbrella command unless you need to archive only plans.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/plans/*.md", "docs/plans/archive/**"],
      reads: ["docs/plans/**/*.md", "docs/rfcs/**/*.md"],
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
      execute: runPlanArchive,
    });
  },
};
