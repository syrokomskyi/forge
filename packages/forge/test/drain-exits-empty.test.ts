/*
<MODULE_CONTRACT>
<purpose>
RFC-1647 AC-5: the drain worker exits when the queue is empty and never persists
as a daemon — drain runs in-process, returns, and leaves no lease behind.
</purpose>
<CHANGE_SUMMARY><item>WP-4 initial.</item></CHANGE_SUMMARY>
*/
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { drainQueue } from "../src/integration/drain.ts";
import { enqueueUnit } from "../src/integration/enqueue.ts";
import { materializeTree } from "../src/integration/materialize.ts";
import { createFixtureRepo, buildSessionChain } from "./helpers/git-fixture.ts";
import { createQueueFixture, mkTmp } from "./helpers/queue-fixture.ts";

describe("drain exits empty (AC-5)", () => {
  it("drain on an empty queue returns immediately and leaves no lease", async () => {
    const repo = createFixtureRepo(mkTmp("forge-empty-repo-"));
    const fx = createQueueFixture(mkTmp("forge-empty-queue-"), mkTmp("forge-empty-evidence-"));

    const started = Date.now();
    const report = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
    });
    expect(report.status).toBe("empty");
    expect(report.processed).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(5_000); // exits — no daemon wait loop

    // The lease is released — no residue proving daemon persistence.
    expect(existsSync(join(fx.queueDir, "lease.json"))).toBe(false);
  });

  it("drain processes the queue then exits — a follow-up drain finds nothing", async () => {
    const repo = createFixtureRepo(mkTmp("forge-exit-repo-"));
    const fx = createQueueFixture(mkTmp("forge-exit-queue-"), mkTmp("forge-exit-evidence-"));

    const s = buildSessionChain(repo, [["once.txt", "once\n"]]);
    enqueueUnit(fx.store, {
      treeDigest: s.treeDigest,
      baseRef: repo.head(),
      sessionId: "s1",
      worktreePath: "/tmp/x",
      governanceIds: [],
      commitChain: s.chain,
    });

    const first = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
      treeMaterializer: (_r, tree) => materializeTree(repo.dir, tree).root,
    });
    expect(first.status).toBe("drained");
    expect(existsSync(join(fx.queueDir, "lease.json"))).toBe(false);

    const second = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
    });
    expect(second.status).toBe("empty");
  });
});
