/*
<MODULE_CONTRACT>
<purpose>Register the forge naming convention lint command with the Site OS kernel registry.</purpose>
<non-goals>
  <item>Do not register project-specific naming commands (naming.pages.lint, etc.) — those stay in site-kernel-checks.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forgeNamingModule registering naming.convention.lint.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export const forgeNamingModule: ForgeModule = {
  name: "forge-naming",
  version: "0.1.0",
  async register(registry) {
    const { runNamingConventionLint } = await import("./naming-convention.ts");
    registry.registerCommand({
      name: "naming.convention.lint",
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
    });
  },
};
