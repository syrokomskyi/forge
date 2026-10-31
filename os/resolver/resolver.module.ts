/*
<MODULE_CONTRACT>
<purpose>Register forgeResolverModule — the canonical-reader parity audit surface (RFC-1465).</purpose>
<non-goals>
  <item>Autonomous module — no engine imports (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1465: forgeResolverModule registering resolver.doors.audit</item>
  <item>RFC-1465: canonical-reader parity audit — resolver.doors.audit with DOOR-01/02/03 over forge.yaml registry</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runResolverDoorsAudit } from "./handlers/resolver-doors-audit.ts";

export const forgeResolverModule: ForgeModule = {
  name: "forge-resolver",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "resolver.doors.audit",
      coverage: "operator" as const,
      mutatesState: false,
      contract: "resolver",
      rules: [
        { id: "DOOR-01", severity: "warning" },
        { id: "DOOR-02", severity: "warning" },
        { id: "DOOR-03", severity: "warning" },
      ],
      description:
        "RFC-1465: audit canonical-reader parity — DOOR-01 undeclared door importing the canonical reader or globbing domain dirs, DOOR-02 declared door not importing the canonical reader, DOOR-03 canonical path missing or exporting nothing. Wave-1: all diagnostics warnings.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {},
      reads: ["forge.yaml", "packages/**/*.ts", "services/**/*.ts", "tools/**/*.ts"],
      execute: runResolverDoorsAudit,
    },
  ],
  pipelines: [],
};
