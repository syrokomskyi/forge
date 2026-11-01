/*
<MODULE_CONTRACT>
<purpose>Register forgeContextModule — context.index.build, context.assemble, context.slate.eval (RFC-1470): task-time context slate retrieval.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1470: forgeContextModule registering the slate-retrieval commands</item>
  <item>RFC-1470: context.index.build + context.assemble + context.slate.eval — slate-retrieval projection over the artifact corpus</item>
  <item>RFC-1470: declare generated index files in context.index.build and trajectory.index writes</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runIndexBuild } from "./handlers/index-build.ts";
import { runContextAssemble } from "./handlers/context-assemble.ts";
import { runSlateEval } from "./handlers/context-slate-eval.ts";

export const forgeContextModule: ForgeModule = {
  name: "forge-context",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "context.index.build",
      coverage: "operator" as const,
      contract: "context",
      mutatesState: true,
      description:
        "RFC-1470: rebuild docs/.index/context/index.yaml — a pure-projection unit catalog (session-block, knowledge-entry, friction, remediation, rfc-header, adr-header, skill-manifest, handoff, decision). Drop the dir, rebuild from sources.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {},
      reads: ["docs/sessions/**/*.md", ".agents/**", "docs/frictions.yaml", "docs/remediation-catalog.*.yaml", "docs/rfcs/**", "docs/adrs/**", "packages/forge/skills/**", "docs/handoffs/**", "docs/queues/*decisions.yaml"],
      writes: ["docs/.index/context/**", "docs/.index/context/index.yaml"],
      generates: [{ path: "docs/.index/context/index.yaml", phase: "on-demand" as const }],
      execute: runIndexBuild,
    },
    {
      name: "context.assemble",
      coverage: "operator" as const,
      contract: "context",
      mutatesState: false,
      description:
        "RFC-1470: emit a budgeted context slate for --task — units ranked by lexical overlap + recency + kind weight + path overlap, each citing source + reasons. Flags: --task, --budget, --paths, --auto-index, --format markdown.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        task: { kind: "string", description: "Task description to retrieve context for." },
        budget: { kind: "string", description: "Token budget for the slate (default 4000)." },
        paths: { kind: "string", description: "Path glob terms to boost (e.g. the files being edited)." },
        "auto-index": { kind: "boolean", description: "Build the index lazily when missing." },
        format: { kind: "string", description: "markdown for a paste-ready block." },
      },
      reads: ["docs/.index/context/index.yaml"],
      execute: runContextAssemble,
    },
    {
      name: "context.slate.eval",
      coverage: "operator" as const,
      contract: "context",
      mutatesState: false,
      description:
        "RFC-1470: report recall@budget over docs/context-devset/ task → requiredUnits pairs — the completeness metric and ranker-change regression gate.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        budget: { kind: "string", description: "Token budget for the recall measurement (default 4000)." },
      },
      reads: ["docs/.index/context/index.yaml", "docs/context-devset/*.yaml"],
      execute: runSlateEval,
    },
  ],
  pipelines: [],
};
