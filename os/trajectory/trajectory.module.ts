/*
<MODULE_CONTRACT>
<purpose>Register forgeTrajectoryModule — trajectory.index, trajectory.recall, trajectory.outcome.record (RFC-1472): procedural-memory retrieval.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1475: rules[] per emitter (TRAJ-01/02/03/04/05/06) + JSONL journal paths in reads/writes</item>
  <item>RFC-1472: forgeTrajectoryModule registering the trajectory commands</item>
  <item>RFC-1472: trajectory.index + trajectory.recall + trajectory.outcome.record — procedural-memory retrieval with green-verdict admission</item>
  <item>RFC-1475: apply review round-1 findings — vendored-label replay order, real workshopId, cache bypass, TRAJ-06 diagnostics, ENOENT-only journal reads</item>
  <item>RFC-1475: apply review round-2 findings — element-shape index validation, early-return TRAJ-06 diagnostics, declared forge.yaml/journal reads, hardened shard-unit shape</item>
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
      rules: [{ id: "TRAJ-03", severity: "error" }, { id: "TRAJ-04", severity: "warning" }, { id: "TRAJ-06", severity: "warning" }],
      mutatesState: true,
      cacheable: false,
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
      reads: ["docs/sessions/**/*.md", "missions/*/evidence/validation-report.json", "docs/.index/trajectory/*.jsonl", "forge.yaml"],
      writes: ["docs/.index/trajectory/**"],
      generates: [{ path: "docs/.index/trajectory/units.yaml", phase: "on-demand" as const }],
      execute: runTrajectoryIndex,
    },
    {
      name: "trajectory.recall",
      coverage: "operator" as const,
      contract: "trajectory",
      rules: [{ id: "TRAJ-01", severity: "error" }, { id: "TRAJ-02", severity: "error" }, { id: "TRAJ-06", severity: "warning" }],
      mutatesState: true,
      // A journaled invocation must never replay — the kernel result cache
      // would skip both the recalls.jsonl append and the TRAJ-02 staleness gate.
      cacheable: false,
      description:
        "RFC-1472: top-k procedure units by situation similarity — decision-point recall (task start, approach selection, unfamiliar diagnostic). Journaled to docs/.index/trajectory/recalls.jsonl. Flags: --task, --paths, --k.",
      scope: "workspace",
      acceptsAllFlag: false,
      flags: {
        task: { kind: "string", description: "Task description for situation matching." },
        paths: { kind: "string", description: "Path terms to boost (files being edited)." },
        k: { kind: "string", description: "Top-k units (default 5)." },
      },
      reads: ["docs/.index/trajectory/units.yaml", "docs/.index/trajectory/recalls.jsonl", "docs/sessions/**/*.md"],
      writes: ["docs/.index/trajectory/recalls.jsonl"],
      generates: [],
      execute: runTrajectoryRecall,
    },
    {
      name: "trajectory.outcome.record",
      coverage: "operator" as const,
      contract: "trajectory",
      rules: [{ id: "TRAJ-01", severity: "error" }, { id: "TRAJ-02", severity: "error" }, { id: "TRAJ-05", severity: "error" }, { id: "TRAJ-06", severity: "warning" }],
      mutatesState: true,
      cacheable: false,
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
      reads: ["docs/.index/trajectory/recalls.jsonl", "docs/.index/trajectory/outcomes.jsonl", "docs/.index/trajectory/units.yaml"],
      writes: ["docs/.index/trajectory/units.yaml", "docs/.index/trajectory/outcomes.jsonl", "docs/.index/trajectory/recalls.jsonl"],
      generates: [],
      execute: runOutcomeRecord,
    },
  ],
  pipelines: [],
};
