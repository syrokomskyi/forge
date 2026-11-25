/*
<MODULE_CONTRACT>
<purpose>
Failure-class separation in the drain: executor errors are verdict-bearing failures
(RFC-1646 error semantics — error is neither pass nor cached, attributed to the node);
true evaluation-infrastructure catastrophes are bounded-requeued then terminally
refused — the drain never hangs on a poison pill.
</purpose>
<CHANGE_SUMMARY><item>WP-4 hardening — corrected failure-class coverage.</item></CHANGE_SUMMARY>
*/
import { describe, expect, it } from "vitest";

import { drainQueue, MAX_INFRA_REQUEUE_ATTEMPTS } from "../src/integration/drain.ts";
import { enqueueUnit } from "../src/integration/enqueue.ts";
import { materializeTree } from "../src/integration/materialize.ts";
import type { Executor } from "../src/contract/evaluator.ts";
import { createFixtureRepo, buildSessionChain } from "./helpers/git-fixture.ts";
import { createQueueFixture, mkTmp } from "./helpers/queue-fixture.ts";

async function setup(repo: ReturnType<typeof createFixtureRepo>, fx: ReturnType<typeof createQueueFixture>) {
  const s = buildSessionChain(repo, [["poison.txt", "poison\n"]]);
  const unit = enqueueUnit(fx.store, {
    treeDigest: s.treeDigest,
    baseRef: repo.head(),
    sessionId: "s-poison",
    worktreePath: "/tmp/x",
    governanceIds: [],
    commitChain: s.chain,
  });
  return unit;
}

describe("drain failure-class separation", () => {
  it("executor throw becomes an error verdict — immediate refusal attributed to the node, no requeue loop", async () => {
    const repo = createFixtureRepo(mkTmp("forge-exec-err-repo-"));
    const fx = createQueueFixture(mkTmp("forge-exec-err-queue-"), mkTmp("forge-exec-err-evidence-"));
    const unit = await setup(repo, fx);

    const throwing: Record<string, Executor> = Object.fromEntries(
      Object.keys(fx.executors).map((k) => [
        k,
        async () => {
          throw new Error("executor blew up");
        },
      ]),
    );

    const started = Date.now();
    const report = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: throwing,
      treeMaterializer: (_r, tree) => materializeTree(repo.dir, tree).root,
    });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(report.processed[0]?.terminal).toBe("refused");
    const finalUnit = fx.store.readUnit(unit.id)!;
    // Error verdicts are not infra failures — refused on FIRST evaluation, no requeue cycling.
    expect(finalUnit.attempts).toBe(0);
    if (finalUnit.state.status === "refused") {
      expect(finalUnit.state.reason.nodeId).not.toBe("core.integration.infra");
    }
  });

  it("evaluation-infrastructure catastrophe bounded-requeues then terminally refuses — never hangs", async () => {
    const repo = createFixtureRepo(mkTmp("forge-infra-repo-"));
    const fx = createQueueFixture(mkTmp("forge-infra-queue-"), mkTmp("forge-infra-evidence-"));
    const unit = await setup(repo, fx);

    // True infrastructure catastrophe: the graph object itself is unreadable —
    // evidence-store corruption alone is cache-miss by design (RFC-1646), never a catastrophe.
    const brokenGraph = new Proxy(fx.graph, {
      get(target, prop) {
        if (prop === "nodes") throw new Error("graph registry corrupted");
        return Reflect.get(target, prop);
      },
    });

    const started = Date.now();
    const report = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: brokenGraph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
      treeMaterializer: (_r, tree) => materializeTree(repo.dir, tree).root,
    });

    expect(Date.now() - started).toBeLessThan(60_000);
    expect(report.status).toBe("drained");
    const finalUnit = fx.store.readUnit(unit.id)!;
    expect(finalUnit.state.status).toBe("refused");
    expect(finalUnit.attempts).toBeGreaterThanOrEqual(MAX_INFRA_REQUEUE_ATTEMPTS);
    if (finalUnit.state.status === "refused") {
      expect(finalUnit.state.reason.nodeId).toBe("core.integration.infra");
    }
  });
});
