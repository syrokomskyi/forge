/*
<MODULE_CONTRACT>
<purpose>ForgeModule interfaces — structurally compatible with KernelModule from @warpgogol/site-kernel. Forge does NOT import from site-kernel. The optional runtime field (RFC-0940) declares whether a module is autonomous or a werkstatt adapter.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/site-kernel — forge must be installable without it.</item>
  <item>Do not add project-specific fields to ForgeModule — keep it minimal and portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial ForgeModule, ForgeModuleRegistry, ForgeCommandDefinition, ForgePipelineStep interfaces.</item>
  <item>RFC-0940: add optional runtime field to ForgeModule for autonomy declaration.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into <history>, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeCommandDefinition } from "./types.ts";

// ForgeModule is structurally compatible with ModuleExport from
// @warpgogol/werkstatt-engine/runtime/desired-state. Forge does NOT import from
// werkstatt-engine — TypeScript structural typing ensures compatibility.
// If the ModuleExport interface changes, the build fails at the point where
// forge modules are imported into kernel.config.ts.

export interface ForgePipelineStep {
  command: string;
  args?: string[];
}

export interface ForgePipelineDeclaration {
  name: string;
  steps: ForgePipelineStep[];
}

/**
 * RFC-1038: ForgeModuleRegistry is kept for the CLI's standalone registry
 * implementation. The kernel no longer uses it — modules export commands/
 * pipelines arrays directly. The CLI uses it to collect commands from
 * ForgeModule.commands[] into its own registry.
 */
export interface ForgeModuleRegistry {
  registerCommand(command: ForgeCommandDefinition): void;
  registerPipeline(name: string, steps: ForgePipelineStep[]): void;
}

export interface ForgeModule {
  name: string;
  version: string;
  runtime: "autonomous" | "werkstatt-adapter";
  declarations: never[];
  commands: ForgeCommandDefinition[];
  pipelines: ForgePipelineDeclaration[];
}

// Re-export canonical types for convenience
export type { ForgeCommandDefinition, ForgeCommandResult, ForgeFlagSpec } from "./types.ts";
