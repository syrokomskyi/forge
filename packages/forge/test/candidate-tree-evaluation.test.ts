/*
<MODULE_CONTRACT>
<purpose>
RFC-1647 AC-3: the contract graph receives the rebase-materialized candidate tree
digest — the exact content that would integrate — never the session's private tree.
</purpose>
<CHANGE_SUMMARY><item>WP-4 initial.</item></CHANGE_SUMMARY>
*/
import { describe, expect, it } from "vitest";

import { drainQueue } from "../src/integration/drain.ts";
import { enqueueUnit } from "../src/integration/enqueue.ts";
import { materializeTree } from "../src/integration/materialize.ts";
import type { Executor } from "../src/contract/evaluator.ts";
import { createFixtureRepo, buildSessionChain } from "./helpers/git-fixture.ts";
import { createQueueFixture, mkTmp, MARKER_NODE } from "./helpers/queue-fixture.ts";

describe("candidate tree evaluation (AC-3)", () => {
  it("executor sees the candidate tree content, not the session tree", async () => {
    const repo = createFixtureRepo(mkTmp("forge-cand-repo-"));
    const fx = createQueueFixture(mkTmp("forge-cand-queue-"), mkTmp("forge-cand-evidence-"));

    // Session writes a file; meanwhile the head moves forward with an unrelated file,
    // so the candidate tree = session content ON TOP of the new head.
    const baseBefore = repo.head();
    const s = buildSessionChain(repo, [["session.txt", "session work\n"]]);
    repo.commitFile("other.txt", "meanwhile on mainline\n", "mainline move");

    enqueueUnit(fx.store, {
      treeDigest: s.treeDigest,
      baseRef: baseBefore,
      sessionId: "session-cand",
      worktreePath: "/tmp/x",
      governanceIds: [],
      commitChain: s.chain,
    });

    // Spy executor records the tree digest handed to the graph.
    const seenDigests: string[] = [];
    const spyExecutors: Record<string, Executor> = Object.fromEntries(
      Object.entries(fx.executors).map(([k, exec]) => [
        k,
        async (args) => {
          seenDigests.push(args.changeUnit.treeDigest);
          return exec(args);
        },
      ]),
    );

    await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: spyExecutors,
      treeMaterializer: (_r, tree) => materializeTree(repo.dir, tree).root,
    });

    expect(seenDigests.length).toBeGreaterThan(0);
    // The evaluated digest is neither the session tree nor the head tree —
    // it is the merged candidate: contains BOTH files.
    expect(seenDigests[0]).not.toBe(s.treeDigest);
    const candidateFiles = execSyncFiles(repo.dir, seenDigests[0]!);
    expect(candidateFiles).toContain("session.txt");
    expect(candidateFiles).toContain("other.txt");
  });

  it("refusal attributes the blocking node and records the evidence key", async () => {
    const repo = createFixtureRepo(mkTmp("forge-refuse-repo-"));
    const fx = createQueueFixture(mkTmp("forge-refuse-queue-"), mkTmp("forge-refuse-evidence-"));

    const s = buildSessionChain(repo, [["bad.txt", "this carries forbidden content\n"]]);
    const unit = enqueueUnit(fx.store, {
      treeDigest: s.treeDigest,
      baseRef: repo.head(),
      sessionId: "session-bad",
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
    expect(report.processed[0]?.terminal).toBe("refused");

    const finalUnit = fx.store.readUnit(unit.id)!;
    expect(finalUnit.state.status).toBe("refused");
    if (finalUnit.state.status === "refused") {
      expect(finalUnit.state.reason.nodeId).toBe(MARKER_NODE);
      expect(finalUnit.state.evidenceKey.length).toBeGreaterThan(0);
    }
  });
});

import { execFileSync } from "node:child_process";
function execSyncFiles(repoDir: string, tree: string): string[] {
  return execFileSync("git", ["ls-tree", "--name-only", "-r", tree], { cwd: repoDir, encoding: "utf8" }).split("\n").filter(Boolean);
}
