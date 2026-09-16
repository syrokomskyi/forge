/*
<MODULE_CONTRACT>
<purpose>TypeScript stack path conventions for werkstatt/plugin@1 (RFC-0889).</purpose>

<non-goals>
  <item>Do not define invariants — those live in invariants/typescript-invariants.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial TypeScript stack path conventions.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into <history>, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
</CHANGE_SUMMARY>
*/

import type { StackPathConventions } from "@warpgogol/werkstatt-shared/plugin";

export const typescriptPathConventions: StackPathConventions = {
  contentDir: "src",
  distDir: "dist",
  entryPoints: ["src/index.ts"],
};
