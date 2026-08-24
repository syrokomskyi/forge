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
  <item>Forge autonomy refactor: ForgeCommandDefinition and ForgeCommandResult now reference canonical types from types.ts.</item>
  <item>RFC-0940: add optional runtime field to ForgeModule for autonomy declaration.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeCommandDefinition } from "./types.ts";

// ForgeModule is structurally compatible with KernelModule from @warpgogol/site-kernel.
// Forge does NOT import from site-kernel — TypeScript structural typing ensures
// compatibility. If the kernel's KernelModule interface changes, the build fails
// at the point where forge modules are imported into kernel.config.ts.

export interface ForgeModuleRegistry {
  registerCommand(command: ForgeCommandDefinition): void;
  registerPipeline(name: string, steps: ForgePipelineStep[]): void;
}

export interface ForgeModule {
  name: string;
  version: string;
  runtime: "autonomous" | "werkstatt-adapter";
  register(registry: ForgeModuleRegistry): void | Promise<void>;
}

// Re-export canonical types for convenience
export type { ForgeCommandDefinition, ForgeCommandResult, ForgeFlagSpec } from "./types.ts";

export interface ForgePipelineStep {
  command: string;
  args?: string[];
}
