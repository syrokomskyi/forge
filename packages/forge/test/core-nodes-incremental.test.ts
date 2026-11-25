/* RFC-1646 WP-3 validation: incremental scheduling demonstrated on real v9
   protections — the first live node registrations with evidence-cone behavior. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { coreContractNodes, coreExecutors } from "../src/contract/core-nodes.ts";
import { createEvidenceStore } from "../src/contract/evidence-store.ts";
import { evaluateGraph } from "../src/contract/evaluator.ts";
import { loadContractGraph } from "../src/contract/graph.ts";
import type { ChangeUnit } from "../src/contract/types.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "core-nodes-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const MAP_FIXTURE = `version: 1
entries:
  - id: PMM-0001
    protection: "fixture"
    disposition: superseded
    reason: "recorded"
`;

function fixtureTree(): string {
  const root = tmp();
  mkdirSync(join(root, "packages", "alpha", "src"), { recursive: true });
  writeFileSync(join(root, "packages", "alpha", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "packages", "alpha", "package.json"), '{"name":"alpha"}\n');
  mkdirSync(join(root, "docs", "migration"), { recursive: true });
  writeFileSync(join(root, "docs", "migration", "protection-migration-map.yaml"), MAP_FIXTURE);
  return root;
}

function unit(id: string): ChangeUnit {
  return {
    id,
    treeDigest: id.padEnd(64, "0"),
    baseRef: "refs/heads/develop",
    createdAt: new Date().toISOString(),
    frozenRefs: {},
    metadata: {},
  };
}

function setup() {
  const nodes = coreContractNodes();
  const loaded = loadContractGraph(
    [{ pluginId: "core", nodes }],
    new Set(nodes.map((n) => n.executorRef)),
  );
  if (!loaded.ok) throw new Error(`fixture graph refused: ${JSON.stringify(loaded.errors)}`);
  return loaded.graph;
}

describe("first real nodes — incremental scheduling demonstration", () => {
  it("both nodes pass on a clean fixture; unchanged inputs fully skip on re-evaluation", async () => {
    const graph = setup();
    const treeRoot = fixtureTree();
    const store = createEvidenceStore(tmp());
    const executors = coreExecutors(() => graph);

    const first = await evaluateGraph({ graph, store, changeUnit: unit("u1"), executors, treeRoot });
    expect(first.blockingPassed).toBe(true);
    expect(first.executedCount).toBe(2);
    expect(first.reusedCount).toBe(0);

    const second = await evaluateGraph({ graph, store, changeUnit: unit("u2"), executors, treeRoot });
    // Unchanged inputs — every node reuses evidence: the >80% skip target's mechanism.
    expect(second.reusedCount).toBe(2);
    expect(second.executedCount).toBe(0);
    expect(second.blockingPassed).toBe(true);
  });

  it("a change in the zero-deps input cone re-executes only that node — the map node reuses", async () => {
    const graph = setup();
    const treeRoot = fixtureTree();
    const store = createEvidenceStore(tmp());
    const executors = coreExecutors(() => graph);

    await evaluateGraph({ graph, store, changeUnit: unit("u1"), executors, treeRoot });

    // Touch ONLY a file in the zero-deps input cone.
    writeFileSync(join(treeRoot, "packages", "alpha", "src", "b.ts"), "export const b = 2;\n");

    const report = await evaluateGraph({ graph, store, changeUnit: unit("u2"), executors, treeRoot });
    const zeroDeps = report.nodes.find((n) => n.nodeId === "core.contract.zero-werkstatt-deps");
    const mapNode = report.nodes.find((n) => n.nodeId === "core.contract.migration-map-completeness");
    expect(zeroDeps?.reused).toBe(false);
    expect(mapNode?.reused).toBe(true);
  });

  it("a werkstatt import in the fixture fails the zero-deps node with blocking violations", async () => {
    const graph = setup();
    const treeRoot = fixtureTree();
    writeFileSync(
      join(treeRoot, "packages", "alpha", "src", "evil.ts"),
      // split literal — an adjacent import-shaped string would trip the scan itself
      'import { x } from "@warpgogol/' + 'werkstatt-shared/fs";\n',
    );
    const report = await evaluateGraph({
      graph,
      store: createEvidenceStore(tmp()),
      changeUnit: unit("u1"),
      executors: coreExecutors(() => graph),
      treeRoot,
    });
    const zeroDeps = report.nodes.find((n) => n.nodeId === "core.contract.zero-werkstatt-deps");
    expect(zeroDeps?.verdict.status).toBe("fail");
    expect(report.blockingPassed).toBe(false);
  });

  it("the nodes pass live against the real forge monorepo tree", async () => {
    const graph = setup();
    const realRoot = join(import.meta.dirname, "..", "..", "..");
    const report = await evaluateGraph({
      graph,
      store: createEvidenceStore(tmp()),
      changeUnit: unit("live"),
      executors: coreExecutors(() => graph),
      treeRoot: realRoot,
    });
    const zeroDeps = report.nodes.find((n) => n.nodeId === "core.contract.zero-werkstatt-deps");
    expect(zeroDeps?.verdict.status).toBe("pass");
  });
});
