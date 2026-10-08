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
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
  <item>RFC-1235: failed-merge accounting tests — classifyLiveMergeOutcome, liveMergeFailureEntry, formatLiveMergeFailure, buildLiveMergeBlock (AC-1..4).</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  collectLiveMergeTargets,
  classifyLiveMergeOutcome,
  liveMergeFailureEntry,
  formatLiveMergeFailure,
  buildLiveMergeBlock,
} from "../spec/live-spec-shared.ts";

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
    const selection = collectLiveMergeTargets([move("RFC-1001", "implemented", "out-of-archive")]);
    expect(selection.candidates).toEqual([]);
    expect(selection.rejected).toEqual([]);
  });
});

describe("docs.archive failed-merge accounting (RFC-1235)", () => {
  it("AC-1: exit-nonzero merge with populated data lands in failed[], not merged[]", () => {
    // RFC-1230 fail-fast shape: exit 1 with a full data object.
    const outcome = classifyLiveMergeOutcome("RFC-1299", {
      exitCode: 1,
      data: {
        command: "spec.live.merge",
        domain: "forge",
        operation: "modified",
        deltas: [],
        conflicts: [],
        dryRun: false,
      },
      summary:
        "spec.live.merge: forge.md exists but has no valid frontmatter — inspect or repair via spec.live.rebuild",
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.entry.id).toBe("RFC-1299");
      expect(outcome.entry.exitCode).toBe(1);
      expect(outcome.entry.error).toContain("no valid frontmatter");
    }
  });

  it("AC-2: thrown merge produces a failed[] entry carrying the error and a printable line", () => {
    const failure = liveMergeFailureEntry("RFC-1299", new Error("boom: disk full"));
    expect(failure.id).toBe("RFC-1299");
    expect(failure.exitCode).toBeUndefined();
    expect(failure.error).toBe("boom: disk full");

    // The pretty path prints formatLiveMergeFailure(entry) via logger.error —
    // asserting the formatted line proves the printed message carries id + error.
    const line = formatLiveMergeFailure(failure);
    expect(line).toContain("RFC-1299");
    expect(line).toContain("boom: disk full");
  });

  it("AC-3: exit-0 merge keeps the merged[] shape and failed[] stays empty", () => {
    const outcome = classifyLiveMergeOutcome("RFC-1230", {
      exitCode: 0,
      data: { domain: "forge", operation: "modified", conflicts: [] },
    });
    expect(outcome).toEqual({
      kind: "merged",
      entry: { id: "RFC-1230", domain: "forge", operation: "modified", conflicts: 0 },
    });
    expect(outcome.kind).toBe("merged");
    const entry =
      outcome.kind === "merged"
        ? outcome.entry
        : liveMergeFailureEntry("RFC-1230", new Error("unreachable"));

    const block = buildLiveMergeBlock([entry], [], 0, false);
    expect(block).toEqual({
      merged: [{ id: "RFC-1230", domain: "forge", operation: "modified", conflicts: 0 }],
      failed: [],
      skipped: 0,
      dryRun: false,
    });
  });

  it("AC-4: all-failed and all-empty runs produce data, never a throw — archive stays non-fatal", () => {
    const failure = liveMergeFailureEntry("RFC-1299", new Error("corrupt"));
    const block = buildLiveMergeBlock([], [failure], 0, false);
    // All-failed still emits the block — otherwise the failures stay invisible.
    expect(block).toEqual({
      merged: [],
      failed: [{ id: "RFC-1299", error: "corrupt" }],
      skipped: 0,
      dryRun: false,
    });
    // Nothing attempted → no block at all (unchanged pre-RFC-1235 silence).
    expect(buildLiveMergeBlock([], [], 0, false)).toBeUndefined();
  });
});
