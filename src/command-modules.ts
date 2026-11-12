/*
<MODULE_CONTRACT>
<purpose>RFC-1573 — the single list of forge command modules. `bin/cli.ts`
  buildRegistry() registers them; `src/onboarding/agents-generate.ts` reads
  their declarations (the detachable set) for generated agent instructions.</purpose>
<non-goals>
  <item>No registration — callers own the registry they build.</item>
  <item>No second list anywhere else — add new modules here only.</item>
</non-goals>
</MODULE_CONTRACT>
*/
import type { ForgeModule } from "./forge-module.ts";

/** Load every forge command module in registration order (lazy imports keep CLI start-up cheap). */
export async function loadForgeCommandModules(): Promise<ForgeModule[]> {
  const modules: Array<ForgeModule | null> = [
    await import("../os/core/core.module.ts").then((m) => m.createForgeCoreModule()),
    await import("../os/rfc/rfc.module.ts").then((m) => m.createForgeRfcModule()),
    await import("../os/adr/adr.module.ts").then((m) => m.createForgeAdrModule()),
    await import("../os/plan/plan.module.ts").then((m) => m.createForgePlanModule()),
    await import("../os/audit/audit.module.ts").then((m) => m.createForgeAuditModule()),
    await import("../os/mission/mission.module.ts").then((m) => m.createForgeMissionModule()),
    await import("../os/spec/spec.module.ts").then((m) => m.createForgeSpecModule()),
    await import("../os/program/program.module.ts").then((m) => m.createForgeProgramModule()),
    await import("../os/plugin/plugin.module.ts").then((m) => m.forgePluginModule),
    await import("../os/workflow/workflow.module.ts").then((m) => m.createForgeWorkflowModule()),
    await import("../os/naming/naming.module.ts").then((m) => m.createForgeNamingModule()),
    await import("../os/compass/compass.module.ts").then((m) => m.forgeCompassModule),
    await import("../os/werkstatt/werkstatt.module.ts").then((m) => m.forgeWerkstattModule),
    await import("../os/session/session.module.ts").then((m) => m.createForgeSessionModule()),
    await import("../os/exploration/exploration.module.ts").then((m) =>
      m.createForgeExplorationModule(),
    ),
    await import("../os/notes/notes.module.ts").then((m) => m.createForgeNotesModule()),
    await import("../os/queue/queue.module.ts").then((m) => m.createForgeQueueModule()),
    await import("../os/gate-run/gate-run.module.ts").then((m) => m.createForgeGateRunModule()),
    await import("../os/authority/authority.module.ts").then((m) => m.createForgeAuthorityModule()),
    await import("../os/conformance/conformance.module.ts").then((m) =>
      m.createForgeConformanceModule(),
    ),
    await import("../os/flow/flow.module.ts").then((m) => m.createForgeFlowModule()),
    await import("../os/system/system.module.ts").then((m) => m.createForgeSystemModule()),
    await import("../os/formal/formal.module.ts").then((m) => m.createForgeFormalModule()),
    await import("../os/friction/friction.module.ts").then((m) => m.createForgeFrictionModule()),
    await import("../os/yaml/yaml.module.ts").then((m) => m.createForgeYamlModule()),
    await import("../os/resolver/resolver.module.ts").then((m) => m.forgeResolverModule),
    await import("../os/instructions/instructions.module.ts").then(
      (m) => m.forgeInstructionsModule,
    ),
    await import("../os/agent/agent.module.ts").then((m) => m.forgeAgentModule),
    await import("../os/knowledge/knowledge.module.ts").then((m) => m.forgeKnowledgeModule),
    await import("../os/gate/gate.module.ts").then((m) => m.forgeGateModule),
    await import("../os/checks/checks.module.ts").then((m) => m.forgeChecksModule),
    await import("../os/context/context.module.ts").then((m) => m.forgeContextModule),
    await import("../os/trajectory/trajectory.module.ts").then((m) => m.forgeTrajectoryModule),
  ];
  return modules.filter((m): m is ForgeModule => m !== null);
}
