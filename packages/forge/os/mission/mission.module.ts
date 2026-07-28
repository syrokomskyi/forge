/*
<MODULE_CONTRACT>
<purpose>Register the mission archive command with the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/archive.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0573: initial forgeMissionModule registering mission.archive command.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeMissionModule: ForgeModule = {
  name: "forge-mission",
  version: "0.1.0",
  async register(registry) {
    const { runMissionArchive } = await import("./handlers/archive.ts");

    registry.registerCommand({
      name: "mission.archive",
      description:
        "Move terminal-state mission directories (state: closed or aborted in " +
        "mission.yaml) into missions/archive/<state>/<missionId>/ subdirectories. " +
        "Bidirectional: moves open missions found in archive subdirectories back " +
        "to missions/. Use --dry-run to preview. Use --status to filter to a " +
        "single terminal status (closed, aborted). " +
        "Prefer the docs.archive umbrella command unless you need to archive only missions.",
      scope: "workspace",
      mutatesState: true,
      writes: ["missions/*", "missions/archive/**"],
      reads: ["missions/**"],
      cacheable: false,
      flags: {
        "dry-run": {
          kind: "boolean",
          description: "Preview what would be moved without touching the filesystem.",
        },
        status: {
          kind: "string",
          description: "Filter to a single terminal status (closed, aborted).",
        },
      },
      execute: runMissionArchive,
    });
  },
};
