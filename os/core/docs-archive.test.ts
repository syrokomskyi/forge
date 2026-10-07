/*
<MODULE_CONTRACT>
<purpose>Unit tests for the docs.archive this-run live-merge selection —
collectLiveMergeTargets derives merge candidates purely from the rfc.archive
moved[] result (into-archive + implemented), keeping a second docs.archive run
at zero merge operations (RFC-1230, AC-3).</purpose>
<non-goals>
  <item>Do not invoke the docs.archive execute closure — the selection helper is the test seam.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1230: initial tests for collectLiveMergeTargets.</item>
  <item>RFC-1230: step 4 — docs.archive merges only this-run moves

Post-loop derives merge targets via collectLiveMergeTargets from the rfc.archive result's moved[] (direction into-archive, status implemented), resolving 'to' with 'from' fallback for dry-run moves. Recursive re-scan of all archived RFCs is gone — repeat runs no-op (AC-3). Merge failures stay non-fatal; V-LS-08 detects resulting coverage gaps.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com></item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import { collectLiveMergeTargets } from "../spec/live-spec-shared.ts";

function move(
  id: string,
  status: string,
  direction: "into-archive" | "out-of-archive" = "into-archive",
) {
  return { id, status, direction, file: `docs/rfcs/${id}.md`, from: "", to: "" };
}

describe("docs.archive collectLiveMergeTargets (AC-3)", () => {
  it("selects only RFCs moved into archive/implemented/ this run", () => {
    const selection = collectLiveMergeTargets([
      move("RFC-1001", "implemented"),
      move("RFC-1002", "rejected"),
      move("RFC-1003", "implemented", "out-of-archive"),
      move("RFC-1004", "superseded"),
    ]);

    expect(selection.candidates).toEqual(["RFC-1001"]);
    expect(selection.rejected).toEqual(["RFC-1002"]);
  });

  it("returns an empty selection when nothing moved — second docs.archive run", () => {
    const selection = collectLiveMergeTargets([]);
    expect(selection.candidates).toEqual([]);
    expect(selection.rejected).toEqual([]);
  });

  it("ignores out-of-archive moves entirely", () => {
    const selection = collectLiveMergeTargets([
      move("RFC-1001", "implemented", "out-of-archive"),
    ]);
    expect(selection.candidates).toEqual([]);
    expect(selection.rejected).toEqual([]);
  });
});
