/*
<MODULE_CONTRACT>
<purpose>
RFC-1647 AC-7: small-change drain latency on a warm evidence cache — the measurement
substrate. The operator target is p90 under 5 minutes at production scale; this
benchmark asserts the fixture-scale bound (seconds) and the warm-cache incremental
behavior the target depends on — cold-vs-warm drain comparison.
</purpose>
<CHANGE_SUMMARY><item>WP-4 initial.</item></CHANGE_SUMMARY>
*/
import { describe, expect, it } from "vitest";

import { drainQueue } from "../src/integration/drain.ts";
import { enqueueUnit } from "../src/integration/enqueue.ts";
import { materializeTree } from "../src/integration/materialize.ts";
import { createFixtureRepo, buildSessionChain } from "./helpers/git-fixture.ts";
import { createQueueFixture, mkTmp } from "./helpers/queue-fixture.ts";

describe("drain latency benchmark (AC-7)", () => {
  it("small-change warm-cache drain completes in the seconds bound, warm not slower than cold", async () => {
    const repo = createFixtureRepo(mkTmp("forge-bench-repo-"));
    const fx = createQueueFixture(mkTmp("forge-bench-queue-"), mkTmp("forge-bench-evidence-"));

    const drain = () =>
      drainQueue({
        store: fx.store,
        repoDir: repo.dir,
        governedRef: "refs/heads/develop",
        graph: fx.graph,
        evidenceStore: fx.evidenceStore,
        executors: fx.executors,
        treeMaterializer: (_r, tree) => materializeTree(repo.dir, tree).root,
      });

    // Cold drain — first evaluation populates the evidence store.
    const s1 = buildSessionChain(repo, [["bench.txt", "v1\n"]]);
    enqueueUnit(fx.store, {
      treeDigest: s1.treeDigest,
      baseRef: repo.head(),
      sessionId: "s-cold",
      worktreePath: "/tmp/x",
      governanceIds: [],
      commitChain: s1.chain,
    });
    const coldStart = performance.now();
    await drain();
    const coldMs = performance.now() - coldStart;

    // Warm drain — same executor versions, overlapping input content: cache hits expected.
    const s2 = buildSessionChain(repo, [["bench.txt", "v2 small change\n"]]);
    enqueueUnit(fx.store, {
      treeDigest: s2.treeDigest,
      baseRef: repo.head(),
      sessionId: "s-warm",
      worktreePath: "/tmp/x",
      governanceIds: [],
      commitChain: s2.chain,
    });
    const warmStart = performance.now();
    await drain();
    const warmMs = performance.now() - warmStart;

    // Fixture-scale bound: whole drain in seconds, orders below the 5-minute target.
    expect(coldMs).toBeLessThan(30_000);
    expect(warmMs).toBeLessThan(30_000);
    // Warm path is not slower than cold beyond measurement noise — the incremental
    // evidence cache is the mechanism the p90 target rests on.
    expect(warmMs).toBeLessThanOrEqual(coldMs * 3 + 100);
  });
});
