/*
<MODULE_CONTRACT>
<purpose>typescript-checks module — registers all six ts.*.validate commands as a single autonomous KernelModule (RFC-0889).</purpose>
<keywords>module, checks, typescript, validators</keywords>
<non-goals>
  <item>Do not import from @warpgogol/werkstatt-engine beyond kernel types.</item>
  <item>Do not import from any stack plugin.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial typescript-checks module with six validators.</item>
</CHANGE_SUMMARY>
*/

import type { KernelModule } from "@warpgogol/werkstatt-engine/kernel/types";
import { createTsconfigValidateCommand } from "./tsconfig-validate.ts";
import { createImportBoundariesValidateCommand } from "./import-boundaries-validate.ts";
import { createPhantomDepsValidateCommand } from "./phantom-deps-validate.ts";
import { createPackageExportsValidateCommand } from "./package-exports-validate.ts";
import { createStrictModeValidateCommand } from "./strict-mode-validate.ts";
import { createBarrelValidateCommand } from "./barrel-validate.ts";

export function createTypescriptCheckModule(): KernelModule {
  return {
    name: "typescript-checks",
    version: "0.1.0",
    register(registry) {
      registry.registerCommand(createTsconfigValidateCommand());
      registry.registerCommand(createImportBoundariesValidateCommand());
      registry.registerCommand(createPhantomDepsValidateCommand());
      registry.registerCommand(createPackageExportsValidateCommand());
      registry.registerCommand(createStrictModeValidateCommand());
      registry.registerCommand(createBarrelValidateCommand());
    },
  };
}
