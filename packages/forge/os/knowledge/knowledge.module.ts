/*
<MODULE_CONTRACT>
<purpose>Register forgeKnowledgeModule — knowledge.rebuild + knowledge.authz.probe (RFC-1468): authorization-relevant agent knowledge bound to authoritative sources and periodic rebuilds.</purpose>
<non-goals>
  <item>Autonomous module — source-text scan + marker-region writes only (FORGE-AUTONOMY-01).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1468: forgeKnowledgeModule registering knowledge.rebuild + knowledge.authz.probe</item>
  <item>RFC-1468: bind authz-relevant knowledge to authoritative sources — knowledge.rebuild + knowledge.authz.probe, KAUTHZ-01..03</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runKnowledgeRebuild } from "./handlers/knowledge-rebuild.ts";
import { runKnowledgeAuthzProbe } from "./handlers/knowledge-authz-probe.ts";

export const forgeKnowledgeModule: ForgeModule = {
  name: "forge-knowledge",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "knowledge.rebuild",
      coverage: "operator" as const,
      mutatesState: true,
      description:
        "RFC-1468: rewrites only inside knowledge-rebuild marker regions from authoritative source rows — --target/--all, --diff (report-only), --check (CI, non-zero on drift). Content outside markers is human-owned and never touched.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        target: { kind: "string", description: "Single file to rebuild (repeatable via --all for the declared set)." },
        all: { kind: "boolean", description: "Rebuild every declared rebuild-region target." },
        diff: { kind: "boolean", description: "Report drift without writing." },
        check: { kind: "boolean", description: "CI mode — non-zero on orphan/missing rows." },
      },
      reads: ["docs/remediation-catalog.generated.yaml", "docs/frictions.yaml", "docs/rfcs/decision-log.generated.yaml", "AGENTS.md", ".agents/**/*.md", "docs/knowledge/**/*.md"],
      writes: ["AGENTS.md", ".agents/**/*.md", "docs/knowledge/**/*.md"],
      generates: [],
      execute: runKnowledgeRebuild,
    },
    {
      name: "knowledge.authz.probe",
      coverage: "operator" as const,
      mutatesState: false,
      contract: "knowledge",
      rules: [
        { id: "KAUTHZ-01", severity: "error" },
        { id: "KAUTHZ-02", severity: "warning" },
        { id: "KAUTHZ-03", severity: "warning" },
      ],
      description:
        "RFC-1468: KAUTHZ-01 authz-relevant entry lacking authorityRefs (blocking), KAUTHZ-02 orphaned authority ref, KAUTHZ-03 authorization-shaped entry without the class marker (grace warning). --classify-only proposes markers, writes nothing.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        "classify-only": { kind: "boolean", description: "Propose class markers for authorization-shaped entries — assistive, writes nothing." },
      },
      reads: [".agents/**/*.md", "docs/knowledge/**/*.md", "docs/rfcs/**", "docs/adrs/**"],
      execute: runKnowledgeAuthzProbe,
    },
  ],
  pipelines: [],
};
