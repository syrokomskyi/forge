/*
<MODULE_CONTRACT>
<purpose>Register forgeTrajectoryModule — trajectory.index, trajectory.recall, trajectory.outcome.record (RFC-1472): procedural-memory retrieval.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1472: forgeTrajectoryModule registering the trajectory commands</item>
  <item>RFC-1472: trajectory.index + trajectory.recall + trajectory.outcome.record — procedural-memory retrieval with green-verdict admission</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";
import { runTrajectoryIndex } from "./handlers/trajectory-index.ts";
import { runTrajectoryRecall } from "./handlers/trajectory-recall.ts";
import { runOutcomeRecord } from "./handlers/outcome-record.ts";

export const forgeTrajectoryModule: ForgeModule = {
  name: "forge-trajectory",
  version: "0.1.0",
  runtime: "autonomous",
  declarations: [],
  commands: [
    {
      name: "trajectory.index",
      coverage: "operator" as const,
      contract: "trajectory",
      mutatesState: true,
      description:
        "RFC-1472: extract procedure units from GREEN-verified sessions into docs/.index/trajectory/units.yaml — admission at extraction (non-green sessions produce nothing). Flags: --session, --since, --rebuild, --export <file>, --import <file>.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        session: { kind: "string", description: "Restrict to one session id." },
        since: { kind: "string", description: "Only sessions after this date." },
        rebuild: { kind: "boolean", description: "Rebuild from scratch." },
        export: { kind: "string", description: "Write a forge/trajectory-shard@1 file." },
        import: { kind: "string", description: "Merge a vendored shard read-only." },
      },
      reads: ["docs/sessions/**/*.md"],
      writes: ["docs/.index/trajectory/**"],
      generates: [{ path: "docs/.index/trajectory/units.yaml", phase: "on-demand" as const }],
      execute: runTrajectoryIndex,
    },
    {
      name: "trajectory.recall",
      coverage: "operator" as const,
      contract: "trajectory",
      mutatesState: true,
      description:
        "RFC-1472: top-k procedure units by situation similarity — decision-point recall (task start, approach selection, unfamiliar diagnostic). Journaled to docs/.index/trajectory/recalls.yaml. Flags: --task, --paths, --k.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        task: { kind: "string", description: "Task description for situation matching." },
        paths: { kind: "string", description: "Path terms to boost (files being edited)." },
        k: { kind: "string", description: "Top-k units (default 5)." },
      },
      reads: ["docs/.index/trajectory/units.yaml"],
      writes: ["docs/.index/trajectory/recalls.yaml"],
      generates: [],
      execute: runTrajectoryRecall,
    },
    {
      name: "trajectory.outcome.record",
      coverage: "operator" as const,
      contract: "trajectory",
      mutatesState: true,
      description:
        "RFC-1472: record helped/hurt for a recall — feeds utilityScore re-ranking + producerTrust. Flags: --recall <id>, --helped | --hurt, --note.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        recall: { kind: "string", description: "The recall id to label." },
        helped: { kind: "boolean", description: "The recall helped." },
        hurt: { kind: "boolean", description: "The recall hurt." },
        note: { kind: "string", description: "Free-text annotation." },
      },
      reads: ["docs/.index/trajectory/recalls.yaml", "docs/.index/trajectory/units.yaml"],
      writes: ["docs/.index/trajectory/units.yaml", "docs/.index/trajectory/outcomes.yaml"],
      generates: [],
      execute: runOutcomeRecord,
    },
  ],
  pipelines: [],
};
