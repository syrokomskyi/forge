/*
<MODULE_CONTRACT>
<purpose>
Minimal contract-graph evaluator (Werkstatt RFC-1646) — executes the affected
nodes of a change unit in topological order with content-addressed evidence reuse.
Verdict vocabulary is exact: uncacheable-pass is never reused across change units;
error never counts as pass for blocking nodes and is never cached (transient
executor failures must not poison the evidence store); pass and fail verdicts are
both cacheable — evidence of failure is still evidence.
</purpose>
<non-goals>
  <item>No parallelism, no cone computation against a base unit, no sampling
  verification of command-output determinism — scheduler maturity lands with the
  transactional queue integration (WP-4). This evaluator proves the schema semantics.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1646 (WP-3): initial evaluator.</item>
</CHANGE_SUMMARY>
*/

import { computeInputFingerprint, evidenceKey, verdictDigest, type FingerprintContext } from "./fingerprint.ts";
import type { ContractGraph } from "./graph.ts";
import type { EvidenceStore } from "./evidence-store.ts";
import type { ChangeUnit, ContractNode, Verdict, Violation } from "./types.ts";

export type ExecutorResult = { status: "pass" } | { status: "fail"; violations: Violation[] };

export type Executor = (input: {
  node: ContractNode;
  treeRoot: string;
  changeUnit: ChangeUnit;
}) => Promise<ExecutorResult>;

export interface EvaluationOptions {
  graph: ContractGraph;
  store: EvidenceStore;
  changeUnit: ChangeUnit;
  executors: Record<string, Executor>;
  treeRoot: string;
  env?: Record<string, string | undefined>;
  execCommand?: FingerprintContext["execCommand"];
  /** Per-executor timeout in ms — an over-running executor is an error verdict, never a pass. */
  executorTimeoutMs?: number;
}

export interface NodeEvaluation {
  nodeId: string;
  verdict: Verdict;
  evidenceKey: string | null;
  reused: boolean;
  durationMs: number;
}

export interface EvaluationReport {
  changeUnitId: string;
  nodes: NodeEvaluation[];
  /** Count of nodes whose evidence was reused at identical input digests — the skip metric substrate. */
  reusedCount: number;
  executedCount: number;
  /** True when every blocking node passed (pass or reused pass). error never counts. */
  blockingPassed: boolean;
}

function isUncacheable(node: ContractNode): boolean {
  // A node with no fingerprintable input is uncacheable by construction — never a stale pass.
  return node.cachePolicy === "uncacheable" || node.inputs.length === 0;
}

async function runExecutor(
  executor: Executor,
  input: { node: ContractNode; treeRoot: string; changeUnit: ChangeUnit },
  timeoutMs: number,
): Promise<Verdict> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      executor(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`executor timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return result;
  } catch (err) {
    // Executor crash/timeout — error is never evidence of compliance.
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Evaluate the graph against a frozen change unit. Fingerprint computation
 * failure is a blocking scheduling-time error — it throws before any execution.
 */
export async function evaluateGraph(options: EvaluationOptions): Promise<EvaluationReport> {
  const { graph, store, changeUnit, executors, treeRoot } = options;
  const timeoutMs = options.executorTimeoutMs ?? 60_000;
  const verdictDigests: Record<string, string> = {};
  const ctxBase: Omit<FingerprintContext, "verdictDigests"> = {
    treeRoot,
    changeUnit,
    env: options.env ?? process.env,
    execCommand: options.execCommand ?? (() => ""),
  };

  // Scheduling phase: fingerprint everything before any execution — an unreadable
  // input is a blocking error at scheduling time, never discovered mid-run.
  const fingerprints = new Map<string, ReturnType<typeof computeInputFingerprint>>();
  for (const nodeId of graph.topologicalOrder) {
    const node = graph.nodes[nodeId];
    if (!node) continue;
    if (isUncacheable(node)) continue;
    // node-verdict inputs resolve during execution in topological order; at
    // scheduling time their digest contribution is the dependency's declared
    // presence. The per-input digest for node-verdict is computed lazily at
    // execution — but the scheduling guarantee (all file/command/env inputs
    // computable) is enforced here.
    const nonVerdictInputs = node.inputs.filter((i) => i.kind !== "node-verdict");
    if (nonVerdictInputs.length > 0) {
      // Throws on unreadable input — scheduling-time blocking error, before any execution.
      computeInputFingerprint(nodeId, nonVerdictInputs, { ...ctxBase, verdictDigests: {} });
    }
  }

  const nodes: NodeEvaluation[] = [];
  for (const nodeId of graph.topologicalOrder) {
    const node = graph.nodes[nodeId];
    if (!node) continue;
    const startedAt = new Date();
    const uncacheable = isUncacheable(node);

    if (!uncacheable) {
      const fp = computeInputFingerprint(nodeId, node.inputs, { ...ctxBase, verdictDigests });
      fingerprints.set(nodeId, fp);
      const key = evidenceKey(nodeId, fp.digest, node.executorVersion);
      const existing = store.read(key);
      if (existing) {
        verdictDigests[nodeId] = verdictDigest(existing.verdict);
        nodes.push({
          nodeId,
          verdict: existing.verdict,
          evidenceKey: key,
          reused: true,
          durationMs: 0,
        });
        continue;
      }
    }

    const executor = executors[node.executorRef];
    let verdict: Verdict;
    if (!executor) {
      verdict = { status: "error", message: `executor '${node.executorRef}' not provided at evaluation` };
    } else {
      verdict = await runExecutor(executor, { node, treeRoot, changeUnit }, timeoutMs);
    }

    // Uncacheable nodes: a pass is marked uncacheable-pass and the verdict is
    // never written to the reusable evidence store.
    let finalVerdict = verdict;
    if (uncacheable && verdict.status === "pass") {
      finalVerdict = { status: "uncacheable-pass" };
    }

    // Evidence policy: pass and fail are cacheable; error and uncacheable-pass never are.
    let key: string | null = null;
    if (!uncacheable && (finalVerdict.status === "pass" || finalVerdict.status === "fail")) {
      const fp = fingerprints.get(nodeId) ?? computeInputFingerprint(nodeId, node.inputs, { ...ctxBase, verdictDigests });
      key = evidenceKey(nodeId, fp.digest, node.executorVersion);
      store.write({
        schema: "forge:evidence/v1",
        key,
        nodeId,
        inputFingerprint: fp,
        verdict: finalVerdict,
        executorVersion: node.executorVersion,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        changeUnitId: changeUnit.id,
        artifactRefs: [],
      });
    }

    verdictDigests[nodeId] = verdictDigest(finalVerdict);
    nodes.push({
      nodeId,
      verdict: finalVerdict,
      evidenceKey: key,
      reused: false,
      durationMs: Date.now() - startedAt.getTime(),
    });
  }

  const blockingPassed = nodes.every((n) => {
    const node = graph.nodes[n.nodeId];
    if (!node || node.severity !== "blocking") return true;
    return n.verdict.status === "pass" || n.verdict.status === "uncacheable-pass";
  });

  return {
    changeUnitId: changeUnit.id,
    nodes,
    reusedCount: nodes.filter((n) => n.reused).length,
    executedCount: nodes.filter((n) => !n.reused).length,
    blockingPassed,
  };
}
