/*
<MODULE_CONTRACT>
<purpose>Register the agent-tools command surface (RFC-1591): command.tools.generate projects the command manifest into docs/agent-tools.generated.json — the typed tool surface the forge agent-tools MCP server serves.</purpose>
<non-goals>
  <item>No MCP server code here — the serve path lives in serve.ts behind the `forge agent-tools serve` CLI verb.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1591: initial module — command.tools.generate (+ --check) writes forge/agent-tools@1 docs/agent-tools.generated.json from the command manifest ∪ forge.yaml agentTools.{front,deny}; AGENT-TOOL-03 caps the front set at 40, AGENT-TOOL-04 refuses front names absent from the manifest.</item>
  <item>RFC-1591: typed agent tool surface generated from the command manifest

command.tools.generate projects docs/command-manifest.generated.yaml plus
forge.yaml agentTools.{front,deny} into docs/agent-tools.generated.json
(forge/agent-tools@1); forge agent-tools serve (forge-tools in .mcp.json)
serves it over stdio MCP — three meta tools (command_search /
command_describe / command_run) plus one typed tool per front entry.
Agents now call kernel commands as schema-validated tools instead of
shell strings (F-0037/F-0054/F-0083/F-0116/F-0239 signature).

- flag→JSON-Schema mapping (string/boolean/string[]/enum; flagsOpen keeps
  additionalProperties); required list mirrors the manifest's required
  flags; annotations derive from mutatesState
- command_run refuses AGENT-TOOL-01 on undeclared args (RFC-1514
  nearest-flag suggestion inlined for autonomy), AGENT-TOOL-02 on the
  deny list, AGENT-TOOL-05 on unknown names; detachable commands spawn
  with --detach and return the gate-run id; runner is pnpm exec
  werkstatt run where the bin resolves, pnpm exec forge otherwise
- generator refusals: AGENT-TOOL-03 (>40 front), AGENT-TOOL-04 (front
  name absent from the manifest); --check fails on byte drift
- serve regenerates the file in memory on manifestHash drift and warns;
  agent-tools.generated.json joins the flow.integrate step-(3b) owner
  registry
- forge.yaml seeds 20 front + 7 deny entries; agent-operations guide
  prefers typed tools, shell strings stay the no-server fallback
- werkstatt-engine extract excludes build-input-set.test.ts (reads the
  werkstatt-site boilerplate — monorepo-only); fo-session-retro restores
  the 'recurrences' wording the addressed-match routing test pins</item>
  <item>RFC-1592: retire 7 unprobeable blocking rules and probe COMPASS-DOC-01/KAUTHZ-01, unblocking the RFC-1592 ratchet</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeAgentToolsModule(): Promise<ForgeModule> {
  const { runCommandToolsGenerate } = await import("./handlers/tools-generate.ts");
  return {
    name: "forge-agent-tools",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "command.tools.generate",
        modulePath: "packages/forge/os/agent-tools/agent-tools.module.ts",
        mutatesState: true,
        coverage: "operator" as const,
        coverageNote:
          "operator-invoked generator; also re-derived by flow.integrate step (3b) via the .generated basename owner registry and exercised by `forge agent-tools serve`",
        contract: "agent-tools",
        rules: [],
        description:
          "Generate docs/agent-tools.generated.json (forge/agent-tools@1) — the " +
          "typed agent-tool surface projected from the command manifest and " +
          "forge.yaml agentTools.front/deny (RFC-1591). --check fails on drift " +
          "instead of writing. AGENT-TOOL-03 caps the front set at 40; " +
          "AGENT-TOOL-04 refuses front names absent from the manifest.",
        scope: "workspace",
        acceptsAllFlag: true,
        flags: {
          check: {
            kind: "boolean",
            description: "Verify the generated file is current; exit 1 on drift without writing.",
          },
        },
        reads: ["docs/command-manifest.generated.yaml", "forge.yaml"],
        writes: ["docs/agent-tools.generated.json"],
        generates: [{ path: "docs/agent-tools.generated.json", phase: "on-demand" }],
        cacheable: false,
        execute: runCommandToolsGenerate,
      },
    ],
    pipelines: [],
  };
}
