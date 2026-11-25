/* RFC-1646 AC-2: a dependsOn cycle refuses at load with a typed configuration error. */
import { describe, expect, it } from "vitest";

import { loadContractGraph } from "../src/contract/graph.ts";
import type { ContractNode } from "../src/contract/types.ts";

function node(id: string, dependsOn: string[]): ContractNode {
  return {
    id,
    kind: "validator",
    owner: "core",
    inputs: [],
    substrate: "static",
    severity: "blocking",
    executorRef: "e",
    executorVersion: "1.0.0",
    dependsOn,
    cachePolicy: "content-addressed",
    description: id,
  };
}

describe("contract graph cycles — AC-2", () => {
  it("refuses a two-node cycle with CG-REG-02 naming the cycle", () => {
    const result = loadContractGraph(
      [{ pluginId: "core", nodes: [node("core.a", ["core.b"]), node("core.b", ["core.a"])] }],
      new Set(["e"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycle = result.errors.find((e) => e.ruleId === "CG-REG-02");
      expect(cycle).toBeDefined();
      expect(cycle?.message).toContain("core.a");
      expect(cycle?.message).toContain("core.b");
    }
  });

  it("refuses a self-dependency", () => {
    const result = loadContractGraph(
      [{ pluginId: "core", nodes: [node("core.self", ["core.self"])] }],
      new Set(["e"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.ruleId === "CG-REG-02")).toBe(true);
  });

  it("accepts a genuine DAG and emits topological order dependencies-first", () => {
    const result = loadContractGraph(
      [
        {
          pluginId: "core",
          nodes: [node("core.c", ["core.b"]), node("core.a", []), node("core.b", ["core.a"])],
        },
      ],
      new Set(["e"]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.graph.topologicalOrder;
      expect(order.indexOf("core.a")).toBeLessThan(order.indexOf("core.b"));
      expect(order.indexOf("core.b")).toBeLessThan(order.indexOf("core.c"));
    }
  });
});
