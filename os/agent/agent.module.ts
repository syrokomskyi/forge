/*
<MODULE_CONTRACT>
<purpose>Register forgeAgentModule — the delegation surface: agent.delegate orchestration + agent.delegate.tiers.validate declaration lint (RFC-1464).</purpose>
<non-goals>
  <item>Autonomous module — gate runs go through context.invoke, adapter exec through context.io (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1464: forgeAgentModule registering agent.delegate + agent.delegate.tiers.validate</item>
  <item>RFC-1464: delegate mechanical task classes to cheap tier — agent.delegate, tiers.validate, invoke adapters</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runAgentDelegate } from "./handlers/agent-delegate.ts";
import { runAgentTiersValidate } from "./handlers/agent-tiers-validate.ts";

export const forgeAgentModule: ForgeModule = {
  name: "forge-agent",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "agent.delegate",
      coverage: "operator" as const,
      mutatesState: true,
      description:
        "RFC-1464: delegate a declared mechanical task class to the cheap execution tier — resolves forge.yaml delegable[]+agentTiers.cheap, invokes the declared adapter, runs every gate[] validator, verdicts done|escalated|failed|refused. Flags: --class, --input.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        class: { kind: "string", required: true, description: "Delegable task class id (declared in forge.yaml delegable[])." },
        input: { kind: "string", description: "JSON task input merged into the class envelope." },
      },
      reads: ["forge.yaml"],
      writes: ["**"],
      generates: [],
      execute: runAgentDelegate,
    },
    {
      name: "agent.delegate.tiers.validate",
      coverage: "operator" as const,
      mutatesState: false,
      contract: "agent",
      rules: [
        { id: "DEL-01", severity: "error" },
        { id: "DEL-02", severity: "warning" },
        { id: "DEL-03", severity: "error" },
        { id: "DEL-04", severity: "warning" },
        { id: "DEL-05", severity: "error" },
      ],
      description:
        "RFC-1464: lint delegable[] + agentTiers declarations — DEL-01 unresolvable gate ref, DEL-02 non-validation gate, DEL-03 missing schema, DEL-04 missing boundary, DEL-05 broken binding or literal secrets.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {},
      reads: ["forge.yaml", "docs/command-manifest.generated.yaml"],
      execute: runAgentTiersValidate,
    },
  ],
  pipelines: [],
};
