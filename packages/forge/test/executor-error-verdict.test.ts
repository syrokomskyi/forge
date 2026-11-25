/* RFC-1646 AC-6: an executor error is an error verdict, never counts as pass
   for blocking nodes, and is never cached. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEvidenceStore } from "../src/contract/evidence-store.ts";
import { evaluateGraph } from "../src/contract/evaluator.ts";
import { loadContractGraph } from "../src/contract/graph.ts";
import type { ChangeUnit, ContractNode } from "../src/contract/types.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cg-execerr-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function unit(): ChangeUnit {
  return {
    id: "u",
    treeDigest: "x".repeat(64),
    baseRef: "refs/heads/develop",
    createdAt: new Date().toISOString(),
    frozenRefs: {},
    metadata: {},
  };
}

function cacheableNode(id: string, executorRef: string, severity: "blocking" | "advisory"): ContractNode {
  return {
    id,
    kind: "validator",
    owner: "core",
    inputs: [{ kind: "file-content", path: "input.txt" }],
    substrate: "execution",
    severity,
    executorRef,
    executorVersion: "1.0.0",
    dependsOn: [],
    cachePolicy: "content-addressed",
    description: id,
  };
}

describe("executor error verdicts — AC-6", () => {
  it("a throwing executor yields error, blockingPassed false, and nothing cached", async () => {
    const treeRoot = tmp();
    writeFileSync(join(treeRoot, "input.txt"), "data");
    const node = cacheableNode("core.crash", "crasher", "blocking");
    const loaded = loadContractGraph([{ pluginId: "core", nodes: [node] }], new Set(["crasher"]));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    let invocations = 0;
    const executors = {
      crasher: async () => {
        invocations += 1;
        throw new Error("boom");
      },
    };
    const store = createEvidenceStore(tmp());
    const first = await evaluateGraph({
      graph: loaded.graph,
      store,
      changeUnit: unit(),
      executors: executors as never,
      treeRoot,
    });
    const v = first.nodes.find((n) => n.nodeId === "core.crash");
    expect(v?.verdict.status).toBe("error");
    expect(first.blockingPassed).toBe(false);
    expect(v?.evidenceKey).toBeNull();

    // Error is never cached — identical inputs re-execute.
    const second = await evaluateGraph({
      graph: loaded.graph,
      store,
      changeUnit: unit(),
      executors: executors as never,
      treeRoot,
    });
    expect(second.nodes.find((n) => n.nodeId === "core.crash")?.reused).toBe(false);
    expect(invocations).toBe(2);
  });

  it("pass verdicts ARE reused at identical input digests — the skip substrate", async () => {
    const treeRoot = tmp();
    writeFileSync(join(treeRoot, "input.txt"), "data");
    const node = cacheableNode("core.clean", "clean", "blocking");
    const loaded = loadContractGraph([{ pluginId: "core", nodes: [node] }], new Set(["clean"]));
    if (!loaded.ok) throw new Error("fixture load failed");
    let invocations = 0;
    const executors = {
      clean: async () => {
        invocations += 1;
        return { status: "pass" as const };
      },
    };
    const store = createEvidenceStore(tmp());
    await evaluateGraph({ graph: loaded.graph, store, changeUnit: unit(), executors, treeRoot });
    const second = await evaluateGraph({ graph: loaded.graph, store, changeUnit: unit(), executors, treeRoot });
    expect(second.nodes[0]?.reused).toBe(true);
    expect(second.nodes[0]?.verdict.status).toBe("pass");
    expect(invocations).toBe(1);
    expect(second.blockingPassed).toBe(true);
  });

  it("an advisory node's error surfaces but does not block", async () => {
    const treeRoot = tmp();
    writeFileSync(join(treeRoot, "input.txt"), "data");
    const node = cacheableNode("core.advisory-err", "crasher", "advisory");
    const loaded = loadContractGraph([{ pluginId: "core", nodes: [node] }], new Set(["crasher"]));
    if (!loaded.ok) throw new Error("fixture load failed");
    const executors = {
      crasher: async () => {
        throw new Error("boom");
      },
    };
    const report = await evaluateGraph({
      graph: loaded.graph,
      store: createEvidenceStore(tmp()),
      changeUnit: unit(),
      executors: executors as never,
      treeRoot,
    });
    expect(report.nodes[0]?.verdict.status).toBe("error");
    expect(report.blockingPassed).toBe(true);
  });
});
