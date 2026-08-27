/*
<MODULE_CONTRACT>
<purpose>Werkstatt TypeScript plugin entry point — generic TypeScript TurboRepo stack implementing werkstatt/plugin@1 (RFC-0889).</purpose>
<keywords>plugin, typescript, turborepo, werkstatt</keywords>
<responsibilities>
  <item>Exports werkstattTypescriptPlugin: WerkstattPlugin with profileId "typescript-turborepo".</item>
  <item>Registers TypeScript-stack check module via moduleLoaders.</item>
  <item>Declares TypeScript path conventions via StackPathConventions.</item>
  <item>Surfaces TS-001..006 stack invariants to agents.</item>
</responsibilities>
<non-goals>
  <item>Do not import from @warpgogol/werkstatt-site or any other stack plugin.</item>
  <item>Do not import from the engine package beyond plugin contract types and kernel types.</item>
  <item>Do not add deploy adapters — deployment is workspace infrastructure.</item>
  <item>Do not add new engine hooks — the hook list is closed at five.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial TypeScript plugin entry point — six validators, TS-001..006 invariants, no deploy adapters, no hooks.</item>
</CHANGE_SUMMARY>
*/

import type { WerkstattPlugin } from "@warpgogol/werkstatt-shared/plugin";
import type { KernelModule } from "@warpgogol/werkstatt-engine/kernel/types";
import { typescriptPathConventions } from "./paths/typescript-paths.ts";
import { TYPESCRIPT_INVARIANTS } from "./invariants/typescript-invariants.ts";

export const werkstattTypescriptPlugin: WerkstattPlugin = {
  schema: "werkstatt/plugin@1",
  id: "werkstatt-typescript",
  profileId: "typescript-turborepo",
  paths: typescriptPathConventions,
  moduleLoaders: {
    checks: async (): Promise<KernelModule> =>
      (await import("./checks/module.ts")).createTypescriptCheckModule(),
  },
  invariants: TYPESCRIPT_INVARIANTS,
};

export default werkstattTypescriptPlugin;
