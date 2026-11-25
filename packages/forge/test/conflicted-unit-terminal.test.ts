/*
<MODULE_CONTRACT>
<purpose>
RFC-1647 AC-4: a rebase conflict terminates the unit as `conflicted` with the
conflicting paths; the unit is never retried in place.
</purpose>
<CHANGE_SUMMARY><item>WP-4 initial.</item></CHANGE_SUMMARY>
*/
import { describe, expect, it } from "vitest";

import { drainQueue } from "../src/integration/drain.ts";
import { enqueueUnit, CONFLICTED_RECOVERY_INSTRUCTION } from "../src/integration/enqueue.ts";
import { materializeTree } from "../src/integration/materialize.ts";
import { createFixtureRepo, buildSessionChain } from "./helpers/git-fixture.ts";
import { createQueueFixture, mkTmp } from "./helpers/queue-fixture.ts";

describe("conflicted unit terminal (AC-4)", () => {
  it("conflicting replay terminates as conflicted with named paths and stays terminal", async () => {
    const repo = createFixtureRepo(mkTmp("forge-conflict-repo-"));
    const fx = createQueueFixture(mkTmp("forge-conflict-queue-"), mkTmp("forge-conflict-evidence-"));

    // Seed has seed.txt. Session modifies seed.txt; mainline also modifies seed.txt — conflict.
    const s = buildSessionChain(repo, [["seed.txt", "session version of seed\n"]]);
    repo.commitFile("seed.txt", "mainline version of seed\n", "mainline seed edit");

    const unit = enqueueUnit(fx.store, {
      treeDigest: s.treeDigest,
      baseRef: repo.head(),
      sessionId: "session-conflict",
      worktreePath: "/tmp/x",
      governanceIds: [],
      commitChain: s.chain,
    });

    const report = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
      treeMaterializer: (_r, tree) => materializeTree(repo.dir, tree).root,
    });
    expect(report.processed[0]?.terminal).toBe("conflicted");

    const finalUnit = fx.store.readUnit(unit.id)!;
    expect(finalUnit.state.status).toBe("conflicted");
    if (finalUnit.state.status === "conflicted") {
      expect(finalUnit.state.conflictingPaths).toContain("seed.txt");
    }

    // Never retried in place: a second drain leaves the terminal unit untouched.
    const journalLength = fx.store.journal().length;
    const second = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
    });
    expect(second.status).toBe("empty");
    expect(fx.store.journal().length).toBe(journalLength);
    expect(fx.store.readUnit(unit.id)!.state.status).toBe("conflicted");

    // The recovery contract names the verbatim path.
    expect(CONFLICTED_RECOVERY_INSTRUCTION).toContain("rebases");
    expect(CONFLICTED_RECOVERY_INSTRUCTION).toContain("new id");
  });
});
