/*
<MODULE_CONTRACT>
<purpose>Register the audit archive command with the forge kernel registry.</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/archive.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0521: initial forgeAuditModule registering audit.archive command.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeAuditModule: ForgeModule = {
  name: "forge-audit",
  version: "0.1.0",
  async register(registry) {
    const { runAuditArchive } = await import("./handlers/archive.ts");

    registry.registerCommand({
      name: "audit.archive",
      description:
        "Move audit files whose parent RFC has terminal status " +
        "(implemented, rejected, superseded) into docs/audits/archive/<status>/ " +
        "subdirectories. Bidirectional: moves non-terminal files found in " +
        "subdirectories back to root. Use --dry-run to preview. " +
        "Use --status to filter to a single terminal status. " +
        "Prefer the docs.archive umbrella command unless you need to archive only audits.",
      scope: "workspace",
      mutatesState: true,
      writes: ["docs/audits/*.md", "docs/audits/archive/**"],
      reads: ["docs/audits/**/*.md", "docs/rfcs/**/*.md"],
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
      execute: runAuditArchive,
    });
  },
};
