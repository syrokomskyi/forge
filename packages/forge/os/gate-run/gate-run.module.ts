/*
<MODULE_CONTRACT>
<purpose>RFC-1568 — forge module registration for `gate.run.status`. A forge
  module so both hosts (standalone `forge` CLI + `werkstatt run` kernel) see
  the command through their existing forge-module loading.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1568: step 4 — gate-run module</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeGateRunModule(): Promise<ForgeModule> {
  const { gateRunStatusCommand } = await import("./status.ts");
  return {
    name: "forge-gate-run",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [gateRunStatusCommand],
    pipelines: [],
  };
}
