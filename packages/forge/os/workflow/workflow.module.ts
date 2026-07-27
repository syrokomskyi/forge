/*
<MODULE_CONTRACT>
<purpose>forgeWorkflowModule — registers workflow.lint, workflow.list, and workflow-amend.list commands from forge.</purpose>
<non-goals>
  <item>Do not register app-specific workflow commands.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0075: Add workflow command module.</item>
  <item>RFC-0374: Migrated from packages/os/site-kernel/src/workflow/ to packages/forge/os/workflow/.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeWorkflowModule: ForgeModule = {
  name: "workflow",
  version: "0.1.0",
  async register(registry) {
    const { runWorkflowLint, runWorkflowList, runWorkflowAmendList } =
      await import("./handlers.ts");
    registry.registerCommand({
      name: "workflow.lint",
      description:
        "Validate .agents/workflows AND .agents/workflows-amend markdown frontmatter, command references, " +
        "and per-chain phase links (RFC-0075 + RFC-0136).",
      scope: "workspace",
      flags: {},
      supportsAllSites: true,
      reads: [".agents/workflows/**/*.md", ".windsurf/workflows/**/*.md"],
      execute: runWorkflowLint,
    });
    registry.registerCommand({
      name: "workflow.list",
      description:
        "List .agents/workflows entries with phase, IO summary, and next workflow (RFC-0075).",
      scope: "workspace",
      flags: {},
      supportsAllSites: true,
      reads: [".agents/workflows/**/*.md", ".windsurf/workflows/**/*.md"],
      execute: runWorkflowList,
    });
    registry.registerCommand({
      name: "workflow-amend.list",
      description:
        "List .agents/workflows-amend entries with phase, IO summary, and next workflow (RFC-0136).",
      scope: "workspace",
      flags: {},
      supportsAllSites: true,
      reads: [".agents/workflows-amend/**/*.md"],
      execute: runWorkflowAmendList,
    });
  },
};
