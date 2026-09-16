/*
<MODULE_CONTRACT>
<purpose>Werkstatt TypeScript plugin entry point — generic TypeScript TurboRepo stack implementing werkstatt/plugin@1 (RFC-0889).</purpose>


<non-goals>
  <item>Do not import from @warpgogol/werkstatt-site or any other stack plugin.</item>
  <item>Do not import from the engine package beyond plugin contract types and kernel types.</item>
  <item>Do not add deploy adapters — deployment is workspace infrastructure.</item>
  <item>Do not add new engine hooks — the hook list is closed at five.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial TypeScript plugin entry point — six validators, TS-001..006 invariants, no deploy adapters, no hooks.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
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
