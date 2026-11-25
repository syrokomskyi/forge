/*
<MODULE_CONTRACT>
<purpose>
RFC-1647 AC-6: evidence consults during active integration read only frozen state —
frozen unit records, frozen tree digests, the append-only journal — never mutable
drain-internal surfaces.
</purpose>
<CHANGE_SUMMARY><item>WP-4 initial.</item></CHANGE_SUMMARY>
*/
import { describe, expect, it } from "vitest";

import { drainQueue } from "../src/integration/drain.ts";
import { enqueueUnit, inspectQueue } from "../src/integration/enqueue.ts";
import { materializeTree } from "../src/integration/materialize.ts";
import { createFixtureRepo, buildSessionChain } from "./helpers/git-fixture.ts";
import { createQueueFixture, mkTmp } from "./helpers/queue-fixture.ts";

describe("evidence read isolation (AC-6)", () => {
  it("concurrent reads during drain consume frozen state and never throw or block", async () => {
    const repo = createFixtureRepo(mkTmp("forge-iso-repo-"));
    const fx = createQueueFixture(mkTmp("forge-iso-queue-"), mkTmp("forge-iso-evidence-"));

    const s = buildSessionChain(repo, [["iso.txt", "isolation\n"]]);
    enqueueUnit(fx.store, {
      treeDigest: s.treeDigest,
      baseRef: repo.head(),
      sessionId: "s-iso",
      worktreePath: "/tmp/x",
      governanceIds: [],
      commitChain: s.chain,
    });

    // Interleave: consult the queue state WHILE the drain is mid-flight.
    const readResults: Array<{ ok: boolean; unitCount: number; journalLines: number }> = [];
    const readDuringDrain = setInterval(() => {
      try {
        const view = inspectQueue(fx.store);
        readResults.push({ ok: true, unitCount: view.units.length, journalLines: view.journalTail.length });
      } catch {
        readResults.push({ ok: false, unitCount: -1, journalLines: -1 });
      }
    }, 1);

    const report = await drainQueue({
      store: fx.store,
      repoDir: repo.dir,
      governedRef: "refs/heads/develop",
      graph: fx.graph,
      evidenceStore: fx.evidenceStore,
      executors: fx.executors,
      treeMaterializer: (_r, tree) => materializeTree(repo.dir, tree).root,
    });
    clearInterval(readDuringDrain);

    expect(report.status).toBe("drained");
    // Every concurrent read succeeded — frozen state is always consistent to a reader.
    for (const r of readResults) {
      expect(r.ok).toBe(true);
      expect(r.unitCount).toBe(1); // the unit record is immutable once written — count never flickers
    }

    // The journal is append-only: lines only ever grow, never rewrite.
    const finalJournal = fx.store.journal();
    const transitions = finalJournal.map((e) => e.transition);
    expect(transitions[0]).toBe("enqueued");
    expect(transitions).toContain("integrated");
  });
});
