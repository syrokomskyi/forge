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
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
  <item>RFC-1231: step 1 — rename supportsAllSites to acceptsAllFlag

Mechanical sweep: the field only ever gated --all argv acceptance; fan-out
follows the parsed selector. Guard renamed assertAllSitesAllowed ->
assertAllFlagAccepted, message updated. 417 declaration sites + type
surfaces (KernelCommandMetadata, ForgeCommandMetadata) in one atomic pass.</item>
  <item>RFC-1248: VITE-CLIENT-DEP-02 lazy-import gate + SCAN-02 validator reads-root existence check (RFC-1248)</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeWorkflowModule(): Promise<ForgeModule> {
  const { runWorkflowLint, runWorkflowList, runWorkflowAmendList } = await import("./handlers.ts");
  return {
    name: "workflow",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "workflow.lint",
        mutatesState: false,
        contract: "workflow",
        rules: [],
        description:
          "Validate .agents/workflows AND .agents/workflows-amend markdown frontmatter, command references, " +
          "and per-chain phase links (RFC-0075 + RFC-0136).",
        scope: "workspace",
        flags: {},
        acceptsAllFlag: true,
        reads: [".agents/workflows/**/*.md", ".windsurf/workflows/**/*.md"], // scan-coverage: optional tool dirs — workshops declare workflows under either
        execute: runWorkflowLint,
      },
      {
        name: "workflow.list",
        mutatesState: false,
        description:
          "List .agents/workflows entries with phase, IO summary, and next workflow (RFC-0075).",
        scope: "workspace",
        flags: {},
        acceptsAllFlag: true,
        reads: [".agents/workflows/**/*.md", ".windsurf/workflows/**/*.md"], // scan-coverage: optional tool dirs — workshops declare workflows under either
        execute: runWorkflowList,
      },
      {
        name: "workflow-amend.list",
        mutatesState: false,
        description:
          "List .agents/workflows-amend entries with phase, IO summary, and next workflow (RFC-0136).",
        scope: "workspace",
        flags: {},
        acceptsAllFlag: true,
        reads: [".agents/workflows-amend/**/*.md"],
        execute: runWorkflowAmendList,
      },
    ],
    pipelines: [],
  };
}
