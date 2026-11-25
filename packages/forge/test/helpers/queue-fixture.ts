/* Shared queue fixture — store + graph + executors for integration-queue tests. */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContractGraph, type ContractGraph } from "../../src/contract/graph.ts";
import { createEvidenceStore } from "../../src/contract/evidence-store.ts";
import type { Executor } from "../../src/contract/evaluator.ts";
import type { ContractNode } from "../../src/contract/types.ts";
import { createQueueStore, type QueueStore } from "../../src/integration/store.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export interface QueueFixture {
  store: QueueStore;
  graph: ContractGraph;
  evidenceStore: ReturnType<typeof createEvidenceStore>;
  executors: Record<string, Executor>;
  queueDir: string;
  evidenceDir: string;
}

export const PASS_NODE = "core.gate.always-pass";
export const MARKER_NODE = "core.gate.no-forbidden-marker";

function node(id: string, inputs: ContractNode["inputs"]): ContractNode {
  return {
    id,
    kind: "validator",
    owner: "core",
    inputs,
    substrate: "static",
    severity: "blocking",
    executorRef: `${id}.exec`,
    executorVersion: "1.0.0",
    dependsOn: [],
    cachePolicy: "content-addressed",
    description: id,
  };
}

/** Graph: pass-node gets a real input; marker-node watches all .txt files in the candidate tree. */
export function createQueueFixture(queueDir: string, evidenceDir: string): QueueFixture {
  const nodes = [
    node(PASS_NODE, [{ kind: "file-glob", pattern: "**/*.txt" }]),
    node(MARKER_NODE, [{ kind: "file-glob", pattern: "**/*.txt" }]),
  ];
  const loaded = loadContractGraph(
    [{ pluginId: "core", nodes }],
    new Set(nodes.map((n) => n.executorRef)),
  );
  if (!loaded.ok) throw new Error(`fixture graph refused: ${JSON.stringify(loaded.errors)}`);

  const executors: Record<string, Executor> = {
    [`${PASS_NODE}.exec`]: async () => ({ status: "pass" }),
    [`${MARKER_NODE}.exec`]: async ({ treeRoot }) => {
      // Fails when any .txt file in the candidate tree contains "forbidden".
      const violations = [];
      const scan = (dir: string): void => {
        for (const entry of readdir(dir)) {
          const p = join(dir, entry);
          try {
            if (stat(p).isDirectory()) scan(p);
            else if (entry.endsWith(".txt") && readFileSync(p, "utf8").includes("forbidden")) {
              violations.push({ ruleId: "MARKER-01", message: `${entry} carries the forbidden marker`, severity: "blocking" as const, file: entry });
            }
          } catch {
            // ignore unreadable
          }
        }
      };
      scan(treeRoot);
      return violations.length > 0 ? { status: "fail" as const, violations } : { status: "pass" as const };
    },
  };

  return {
    store: createQueueStore(queueDir),
    graph: loaded.graph,
    evidenceStore: createEvidenceStore(evidenceDir),
    executors,
    queueDir,
    evidenceDir,
  };
}

import { readdirSync, statSync } from "node:fs";
function readdir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function stat(p: string): { isDirectory(): boolean } {
  return statSync(p);
}

export function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function materializerFor(repoDir: string) {
  return (digest: string): string => {
    // Test-side materialization: git archive the tree into a fresh tmp dir.
    const root = mkTmp("forge-test-candidate-");
    execFileSync("sh", ["-c", `git archive "${digest}" | tar -x -C "${root}"`], { cwd: repoDir });
    return root;
  };
}
