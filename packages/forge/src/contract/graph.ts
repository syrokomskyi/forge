/*
<MODULE_CONTRACT>
<purpose>
Contract-graph loader (Werkstatt RFC-1646) — fail-closed registration of contract
nodes: closed input vocabulary enforced, dependsOn DAG with cycle refusal,
plugin id namespacing, executor presence validation, banned command-output
inputs refused at registration. A graph that fails validation never loads.
</purpose>
<non-goals>
  <item>No evaluation — the loader produces validated immutable graph structure only.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1646 (WP-3): initial loader.</item>
</CHANGE_SUMMARY>
*/

import { BANNED_COMMAND_INPUTS } from "./fingerprint.ts";
import { INPUT_KINDS, type ContractNode, type RegistrationError } from "./types.ts";

const INPUT_KIND_SET = new Set<string>(INPUT_KINDS);

export interface ContractGraph {
  /** All validated nodes, keyed by id. Immutable after load. */
  nodes: Readonly<Record<string, ContractNode>>;
  /** Node ids in topological order (dependencies first). */
  topologicalOrder: readonly string[];
}

function validateNode(
  node: ContractNode,
  ownerPluginId: string,
  executorRefs: ReadonlySet<string>,
  errors: RegistrationError[],
): void {
  if (!node.id || typeof node.id !== "string") {
    errors.push({ ruleId: "CG-REG-06", message: "node id missing or not a string" });
    return;
  }
  // Namespace: plugin nodes are prefixed "<pluginId>." — no core/plugin collision by construction.
  if (ownerPluginId !== "core" && !node.id.startsWith(`${ownerPluginId}.`)) {
    errors.push({
      ruleId: "CG-REG-04",
      nodeId: node.id,
      message: `plugin node '${node.id}' must be namespaced '${ownerPluginId}.' — no core/plugin collisions by construction`,
    });
  }
  if (node.owner !== ownerPluginId) {
    errors.push({
      ruleId: "CG-REG-04",
      nodeId: node.id,
      message: `node '${node.id}' declares owner '${node.owner}' but registers through '${ownerPluginId}'`,
    });
  }
  for (const input of node.inputs ?? []) {
    if (!INPUT_KIND_SET.has((input as { kind: string }).kind)) {
      errors.push({
        ruleId: "CG-REG-01",
        nodeId: node.id,
        message: `unknown input kind '${(input as { kind: string }).kind}' — the closed vocabulary is the incrementality guarantee`,
      });
    }
    if (input.kind === "command-output" && BANNED_COMMAND_INPUTS.has(input.command)) {
      errors.push({
        ruleId: "CG-REG-07",
        nodeId: node.id,
        message: `command-output input '${input.command}' is banned (time/random/network-dependent without sealed inputs)`,
      });
    }
    if (input.kind === "node-verdict" && !(node.dependsOn ?? []).includes(input.nodeId)) {
      errors.push({
        ruleId: "CG-REG-05",
        nodeId: node.id,
        message: `node-verdict input on '${input.nodeId}' without a matching dependsOn edge`,
      });
    }
  }
  if (!executorRefs.has(node.executorRef)) {
    errors.push({
      ruleId: "CG-REG-03",
      nodeId: node.id,
      message: `executor '${node.executorRef}' is not registered`,
    });
  }
}

function detectCycles(nodes: Readonly<Record<string, ContractNode>>): string[][] {
  const cycles: string[][] = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of nodes[id]?.dependsOn ?? []) {
      if (!nodes[dep]) continue;
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(dep);
        cycles.push([...stack.slice(idx), dep]);
      } else if (c === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const id of Object.keys(nodes)) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id);
  }
  return cycles;
}

function topoSort(nodes: Readonly<Record<string, ContractNode>>): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of nodes[id]?.dependsOn ?? []) {
      if (nodes[dep]) visit(dep);
    }
    order.push(id);
  };
  for (const id of Object.keys(nodes)) visit(id);
  return order;
}

export interface Registration {
  pluginId: string;
  nodes: ContractNode[];
}

/**
 * Load and validate a contract graph fail-closed. Returns either the validated
 * graph or the complete error list — never a partial graph.
 */
export function loadContractGraph(
  registrations: Registration[],
  executorRefs: ReadonlySet<string>,
): { ok: true; graph: ContractGraph } | { ok: false; errors: RegistrationError[] } {
  const errors: RegistrationError[] = [];
  const nodes: Record<string, ContractNode> = {};

  for (const reg of registrations) {
    for (const node of reg.nodes) {
      validateNode(node, reg.pluginId, executorRefs, errors);
      if (nodes[node.id]) {
        errors.push({ ruleId: "CG-REG-06", nodeId: node.id, message: `duplicate node id '${node.id}'` });
      } else {
        nodes[node.id] = node;
      }
    }
  }

  // Unknown dependencies.
  for (const node of Object.values(nodes)) {
    for (const dep of node.dependsOn ?? []) {
      if (!nodes[dep]) {
        errors.push({
          ruleId: "CG-REG-05",
          nodeId: node.id,
          message: `dependsOn references unknown node '${dep}'`,
        });
      }
    }
  }

  // Cycles are configuration errors refused at load time.
  for (const cycle of detectCycles(nodes)) {
    errors.push({
      ruleId: "CG-REG-02",
      nodeId: cycle[0],
      message: `dependsOn cycle: ${cycle.join(" -> ")}`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, graph: { nodes, topologicalOrder: topoSort(nodes) } };
}
