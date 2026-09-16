/*
<MODULE_CONTRACT>
<purpose>typescript-checks module — registers all six ts.*.validate commands as a single autonomous KernelModule (RFC-0889).</purpose>

<non-goals>
  <item>Do not import from @warpgogol/werkstatt-engine beyond kernel types.</item>
  <item>Do not import from any stack plugin.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial typescript-checks module with six validators.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into <history>, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
</CHANGE_SUMMARY>
*/


import { createTsconfigValidateCommand } from "./tsconfig-validate.ts";
import { createImportBoundariesValidateCommand } from "./import-boundaries-validate.ts";
import { createPhantomDepsValidateCommand } from "./phantom-deps-validate.ts";
import { createPackageExportsValidateCommand } from "./package-exports-validate.ts";
import { createStrictModeValidateCommand } from "./strict-mode-validate.ts";
import { createBarrelValidateCommand } from "./barrel-validate.ts";
import type { ModuleExport } from "@warpgogol/werkstatt-engine/runtime/desired-state";

export function createTypescriptCheckModule(): ModuleExport {
  return {
    name: "typescript-checks",
    version: "0.1.0",
      declarations: [],
  commands: [
      createTsconfigValidateCommand(),
      createImportBoundariesValidateCommand(),
      createPhantomDepsValidateCommand(),
      createPackageExportsValidateCommand(),
      createStrictModeValidateCommand(),
      createBarrelValidateCommand(),
    ],
  pipelines: [

  ]};
}
