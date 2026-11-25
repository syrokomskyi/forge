/*
<MODULE_CONTRACT>
<purpose>
The first real v9-lineage contract nodes (Werkstatt RFC-1646 WP-3c) — thin
executors over existing validator logic, demonstrating incremental scheduling
on real protections. `core.contract.zero-werkstatt-deps` is the live form of
PMM-0004's supersession target; `core.contract.migration-map-completeness` is
the map validating itself — silent loss impossible by construction.
</purpose>
<non-goals>
  <item>Not the full v9 protection decomposition — families node-ify gradually
  as the migration map completes; this is the demonstrated-live seed set.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1646 (WP-3c): first real node registrations.</item>
</CHANGE_SUMMARY>
*/

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Executor } from "./evaluator.ts";
import yaml from "yaml";
import { emitCoverageProof, emitFamiliesCoverageProof, type MigrationMapEntry, type MigrationFamily } from "./migration-map.ts";
import { scanWerkstattDeps } from "./executors/zero-deps.ts";
import type { ContractNode } from "./types.ts";
import type { ContractGraph } from "./graph.ts";

export const CORE_EXECUTOR_ZERO_DEPS = "core.executor.zero-deps";
export const CORE_EXECUTOR_MAP_COMPLETENESS = "core.executor.map-completeness";

export function coreContractNodes(): ContractNode[] {
  return [
    {
      id: "core.contract.zero-werkstatt-deps",
      kind: "validator",
      owner: "core",
      inputs: [
        { kind: "file-glob", pattern: "packages/*/src/**/*.ts" },
        { kind: "file-glob", pattern: "packages/*/os/**/*.ts" },
        { kind: "file-glob", pattern: "packages/*/package.json" },
      ],
      substrate: "static",
      severity: "blocking",
      executorRef: CORE_EXECUTOR_ZERO_DEPS,
      executorVersion: "1.0.0",
      dependsOn: [],
      cachePolicy: "content-addressed",
      description:
        "Zero-dependency contract (RFC-1649 AC-3): no package source or manifest may reference werkstatt-engine/werkstatt-shared. The structural guarantee that superseded FORGE-AUTONOMY-01.",
    },
    {
      id: "core.contract.migration-map-completeness",
      kind: "invariant",
      owner: "core",
      inputs: [{ kind: "file-content", path: "docs/migration/protection-migration-map.yaml" }],
      substrate: "static",
      severity: "blocking",
      executorRef: CORE_EXECUTOR_MAP_COMPLETENESS,
      executorVersion: "1.0.0",
      dependsOn: [],
      cachePolicy: "content-addressed",
      description:
        "The migration map validates itself (RFC-1646): every entry is mapped to a live node or consciously removed with a recorded reason — silent loss impossible.",
    },
  ];
}

export function coreExecutors(graphRef: () => ContractGraph): Record<string, Executor> {
  return {
    [CORE_EXECUTOR_ZERO_DEPS]: async ({ treeRoot }) => {
      const violations = scanWerkstattDeps(treeRoot);
      return violations.length > 0 ? { status: "fail", violations } : { status: "pass" };
    },
    [CORE_EXECUTOR_MAP_COMPLETENESS]: async ({ treeRoot }) => {
      let full: { entries?: MigrationMapEntry[]; families?: MigrationFamily[] };
      try {
        full = yaml.parse(
          readFileSync(join(treeRoot, "docs/migration/protection-migration-map.yaml"), "utf8"),
        ) as { entries?: MigrationMapEntry[]; families?: MigrationFamily[] };
      } catch {
        return {
          status: "fail",
          violations: [
            {
              ruleId: "PMM-MAP-01",
              message: "migration map unreadable",
              severity: "blocking",
            },
          ],
        };
      }
      const entryProof = emitCoverageProof(full.entries ?? [], graphRef());
      const familyProof = emitFamiliesCoverageProof(full.families ?? [], graphRef());
      const proof = {
        complete: entryProof.complete && familyProof.complete,
        gaps: [...entryProof.gaps, ...familyProof.gaps],
      };
      return proof.complete
        ? { status: "pass" }
        : {
            status: "fail",
            violations: proof.gaps.map((g) => ({
              ruleId: "PMM-MAP-02",
              message: `${g.entryId}: ${g.reason}`,
              severity: "blocking" as const,
            })),
          };
    },
  };
}
