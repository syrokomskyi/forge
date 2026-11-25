/* RFC-1646 AC-1: the schema expresses every input kind in the closed vocabulary
   and refuses unknown input kinds at registration, fail-closed. */
import { describe, expect, it } from "vitest";

import { loadContractGraph } from "../src/contract/graph.ts";
import type { ContractNode } from "../src/contract/types.ts";

function baseNode(overrides: Partial<ContractNode>): ContractNode {
  return {
    id: "core.test.node",
    kind: "validator",
    owner: "core",
    inputs: [],
    substrate: "static",
    severity: "blocking",
    executorRef: "test-exec",
    executorVersion: "1.0.0",
    dependsOn: [],
    cachePolicy: "content-addressed",
    description: "test node",
    ...overrides,
  };
}

const executors = new Set(["test-exec"]);

describe("contract graph registration — AC-1 closed input vocabulary", () => {
  it("accepts nodes declaring each of the six input kinds", () => {
    const node = baseNode({
      inputs: [
        { kind: "file-glob", pattern: "src/**/*.ts" },
        { kind: "file-content", path: "package.json" },
        { kind: "git-ref", ref: "refs/heads/develop" },
        { kind: "environment", keys: ["CI"] },
        { kind: "command-output", command: "echo", args: ["hi"] },
      ],
    });
    const dep = baseNode({ id: "core.test.dep" });
    const withVerdict = baseNode({
      id: "core.test.verdict-consumer",
      inputs: [{ kind: "node-verdict", nodeId: "core.test.dep" }],
      dependsOn: ["core.test.dep"],
    });
    const result = loadContractGraph(
      [{ pluginId: "core", nodes: [node, dep, withVerdict] }],
      executors,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an unknown input kind fail-closed with CG-REG-01", () => {
    const node = baseNode({
      inputs: [{ kind: "live-git-read" as never, path: "x" } as never],
    });
    const result = loadContractGraph([{ pluginId: "core", nodes: [node] }], executors);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.ruleId === "CG-REG-01")).toBe(true);
    }
  });

  it("refuses banned command-output inputs at registration (CG-REG-07)", () => {
    const node = baseNode({
      inputs: [{ kind: "command-output", command: "date", args: [] }],
    });
    const result = loadContractGraph([{ pluginId: "core", nodes: [node] }], executors);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.ruleId === "CG-REG-07")).toBe(true);
    }
  });

  it("refuses plugin nodes outside the plugin namespace (CG-REG-04)", () => {
    const node = baseNode({ id: "core.sneaky", owner: "forge-typescript" });
    const result = loadContractGraph(
      [{ pluginId: "forge-typescript", nodes: [node] }],
      executors,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.ruleId === "CG-REG-04")).toBe(true);
    }
  });

  it("refuses missing executors (CG-REG-03) and duplicate ids (CG-REG-06)", () => {
    const missing = baseNode({ id: "core.a", executorRef: "nope" });
    const result = loadContractGraph([{ pluginId: "core", nodes: [missing] }], executors);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.ruleId === "CG-REG-03")).toBe(true);

    const dup1 = baseNode({ id: "core.dup" });
    const dup2 = baseNode({ id: "core.dup" });
    const result2 = loadContractGraph([{ pluginId: "core", nodes: [dup1, dup2] }], executors);
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.errors.some((e) => e.ruleId === "CG-REG-06")).toBe(true);
  });
});
