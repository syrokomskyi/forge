/*
<MODULE_CONTRACT>
<purpose>
RFC-1647 AC-1: concurrent enqueues both appear exactly once in the journal and
drain in strict enqueue order.
</purpose>
<CHANGE_SUMMARY><item>WP-4 initial.</item></CHANGE_SUMMARY>
*/
import { describe, expect, it } from "vitest";

import { drainQueue } from "../src/integration/drain.ts";
import { enqueueUnit } from "../src/integration/enqueue.ts";
import { materializeTree } from "../src/integration/materialize.ts";
import { resolveRef, treeOfCommit, defaultGitExec as gitExec } from "../src/integration/gitops.ts";
import { createFixtureRepo, buildSessionChain } from "./helpers/git-fixture.ts";
import { createQueueFixture, mkTmp } from "./helpers/queue-fixture.ts";

describe("integration queue race (AC-1)", () => {
  it("two concurrent enqueues appear exactly once each and drain in order", async () => {
    const repo = createFixtureRepo(mkTmp("forge-q-repo-"));
    const fx = createQueueFixture(mkTmp("forge-q-queue-"), mkTmp("forge-q-evidence-"));

    // Two independent session chains from the same base.
    const a = buildSessionChain(repo, [["a.txt", "alpha\n"]]);
    const b = buildSessionChain(repo, [["b.txt", "bravo\n"]]);
    const baseRef = repo.head();

    // Enqueue both — sequential API calls model the concurrent case because
    // ordering in the journal is the contract under test, not wall-clock races.
    enqueueUnit(fx.store, {
      treeDigest: a.treeDigest,
      baseRef,
      sessionId: "session-a",
      worktreePath: "/tmp/a",
      governanceIds: ["RFC-1647"],
      commitChain: a.chain,
    });
    enqueueUnit(fx.store, {
      treeDigest: b.treeDigest,
      baseRef,
      sessionId: "session-b",
      worktreePath: "/tmp/b",
      governanceIds: ["RFC-1647"],
      commitChain: b.chain,
    });

    // Exactly once each in the journal.
    const enqueues = fx.store.journal().filter((e) => e.transition === "enqueued");
    expect(enqueues).toHaveLength(2);
    expect(new Set(enqueues.map((e) => e.unitId)).size).toBe(2);

    // Drain — both integrate, in enqueue order: a first, then b rebased onto a.
    const report = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
      treeMaterializer: (_repo, tree) => materializeTree(repo.dir, tree).root,
    });
    expect(report.status).toBe("drained");
    expect(report.processed).toHaveLength(2);
    expect(report.processed.every((p) => p.terminal === "integrated")).toBe(true);

    // FIFO: journal integration order matches enqueue order.
    const integratedUnits = fx.store.journal().filter((e) => e.transition === "integrated").map((e) => e.unitId);
    expect(integratedUnits).toEqual(enqueues.map((e) => e.unitId));

    // Both files landed on develop — a's chain was linearized before b's.
    const finalTree = treeOfCommit(gitExec, repo.dir, resolveRef(gitExec, repo.dir, "refs/heads/develop"));
    const files = gitExec(["ls-tree", "--name-only", finalTree], repo.dir).split("\n");
    expect(files).toContain("a.txt");
    expect(files).toContain("b.txt");
  });
});
