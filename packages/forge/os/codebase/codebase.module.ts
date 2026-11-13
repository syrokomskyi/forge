/*
<MODULE_CONTRACT>
<purpose>
RFC-1581: forge-codebase module — registers codebase.measure, the
project-scale measurement command. Autonomous runtime; no new dependencies.
</purpose>
<non-goals>
  <item>No fleet aggregation — rollup lives at the registry-owning layer.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1581: initial forge-codebase module.</item>
  <item>RFC-1581: add codebase.measure project-scale measurement command</item>
  <item>RFC-1581: apply REVIEW-CODE-2026-11-13-01 — contract alignment, repo-root anchor, publishConfig exports</item>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeCodebaseModule(): Promise<ForgeModule> {
  const { runCodebaseMeasure } = await import("./handlers/codebase-measure.ts");
  return {
    name: "forge-codebase",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "codebase.measure",
        description:
          "Measure project scale over git-tracked files: categorized line counts " +
          "(code/tests/docs/generated), per-language code/comment/blank lines, " +
          "AST-derived class/function/method counts for the TS/JS family, and " +
          "top-10 directories by code lines. Read-only; --out <path> writes an " +
          "explicit YAML snapshot. --json returns the full structured measure.",
        scope: "workspace",
        mutatesState: false,
        // Read-only `git ls-files` probe on the read-only adapter (RFC-1176).
        execOnReadOnly: true,
        // `--out` upgrades this invocation to the real adapter — the only write.
        mutatingFlags: ["out"],
        coverage: "operator",
        coverageNote:
          "Operator-invoked measurement — never wired into build.check, gates, or commit paths.",
        flags: {
          out: {
            kind: "string",
            description: "Write a dated YAML snapshot of the measurement to this explicit path.",
          },
        },
        writes: [],
        execute: runCodebaseMeasure,
      },
    ],
    pipelines: [],
  };
}
