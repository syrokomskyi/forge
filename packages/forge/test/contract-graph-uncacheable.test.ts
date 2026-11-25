/* RFC-1646 AC-3: a node with no fingerprintable input yields uncacheable-pass
   verdicts, never reused across change units. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEvidenceStore } from "../src/contract/evidence-store.ts";
import { evaluateGraph } from "../src/contract/evaluator.ts";
import { loadContractGraph } from "../src/contract/graph.ts";
import type { ChangeUnit, ContractNode } from "../src/contract/types.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cg-uncacheable-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function unit(id: string): ChangeUnit {
  return {
    id,
    treeDigest: "x".repeat(64),
    baseRef: "refs/heads/develop",
    createdAt: new Date().toISOString(),
    frozenRefs: {},
    metadata: {},
  };
}

describe("uncacheable semantics — AC-3", () => {
  it("a node with no inputs passes as uncacheable-pass and re-executes every time", async () => {
    const node: ContractNode = {
      id: "core.always-fresh",
      kind: "validator",
      owner: "core",
      inputs: [],
      substrate: "execution",
      severity: "blocking",
      executorRef: "counting",
      executorVersion: "1.0.0",
      dependsOn: [],
      cachePolicy: "content-addressed",
      description: "no inputs — uncacheable by construction",
    };
    const loaded = loadContractGraph([{ pluginId: "core", nodes: [node] }], new Set(["counting"]));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    let invocations = 0;
    const executors = {
      counting: async () => {
        invocations += 1;
        return { status: "pass" as const };
      },
    };
    const treeRoot = tmp();
    const store = createEvidenceStore(tmp());
    const u = unit("unit-1");

    const first = await evaluateGraph({
      graph: loaded.graph,
      store,
      changeUnit: u,
      executors,
      treeRoot,
    });
    const firstVerdict = first.nodes.find((n) => n.nodeId === "core.always-fresh")?.verdict;
    expect(firstVerdict?.status).toBe("uncacheable-pass");
    expect(first.nodes[0]?.evidenceKey).toBeNull();

    // Same unit, same store — the verdict must NOT be reused.
    const second = await evaluateGraph({
      graph: loaded.graph,
      store,
      changeUnit: u,
      executors,
      treeRoot,
    });
    expect(second.nodes.find((n) => n.nodeId === "core.always-fresh")?.reused).toBe(false);
    expect(invocations).toBe(2);
  });

  it("an explicit cachePolicy uncacheable node is never reused even with inputs", async () => {
    const node: ContractNode = {
      id: "core.policy-uncacheable",
      kind: "oracle",
      owner: "core",
      inputs: [{ kind: "environment", keys: ["DEFINED_FOR_TEST"] }],
      substrate: "review",
      severity: "advisory",
      executorRef: "counting",
      executorVersion: "1.0.0",
      dependsOn: [],
      cachePolicy: "uncacheable",
      description: "explicitly uncacheable",
    };
    const loaded = loadContractGraph([{ pluginId: "core", nodes: [node] }], new Set(["counting"]));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    let invocations = 0;
    const executors = {
      counting: async () => {
        invocations += 1;
        return { status: "pass" as const };
      },
    };
    const treeRoot = tmp();
    const store = createEvidenceStore(tmp());
    const env = { DEFINED_FOR_TEST: "yes" };
    const u = unit("unit-2");
    await evaluateGraph({ graph: loaded.graph, store, changeUnit: u, executors, treeRoot, env });
    await evaluateGraph({ graph: loaded.graph, store, changeUnit: u, executors, treeRoot, env });
    expect(invocations).toBe(2);
  });
});
