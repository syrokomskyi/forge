/*
<MODULE_CONTRACT>
<purpose>Register the forge naming convention lint command with the Site OS kernel registry.</purpose>
<non-goals>
  <item>Do not register project-specific naming commands (naming.pages.lint, etc.) — those stay in site-kernel-checks.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forgeNamingModule registering naming.convention.lint.</item>
  <item>RFC-1173: declare mutatesState on all kernel commands — collectDeclarationDiagnostics emits error-severity MUTATES-STATE-DECLARED, command.manifest.validate is the blocking consumer in packages.check, sweep declares the flag on every command definition (factories hardcode false for read-only check specs)</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeNamingModule(): Promise<ForgeModule> {
  const { runNamingConventionLint } = await import("./naming-convention.ts");
  return {
    name: "forge-naming",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "naming.convention.lint",
        mutatesState: false,
        contract: "naming",
        rules: [],
        description:
          "Validate all filenames use kebab-case (no underscores) across registered workspace roots.",
        scope: "workspace",
        supportsAllSites: true,
        flags: {
          "include-ignored": {
            kind: "boolean",
            description: "Also scan files ignored by .gitignore or .windsurfignore.",
          },
        },
        reads: ["packages/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}", "services/**/*.{ts,tsx}"],
        execute: runNamingConventionLint,
      },
    ],
    pipelines: [],
  };
}
