/*
<MODULE_CONTRACT>
<purpose>TypeScript stack path conventions for werkstatt/plugin@1 (RFC-0889).</purpose>
<keywords>paths, typescript, plugin, werkstatt</keywords>
<non-goals>
  <item>Do not define invariants — those live in invariants/typescript-invariants.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial TypeScript stack path conventions.</item>
</CHANGE_SUMMARY>
*/

import type { StackPathConventions } from "@warpgogol/werkstatt-shared/plugin";

export const typescriptPathConventions: StackPathConventions = {
  contentDir: "src",
  distDir: "dist",
  entryPoints: ["src/index.ts"],
};
