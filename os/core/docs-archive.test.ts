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
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
  <item>RFC-1235: failed-merge accounting tests — classifyLiveMergeOutcome, liveMergeFailureEntry, formatLiveMergeFailure, buildLiveMergeBlock (AC-1..4).</item>
  <item>RFC-1528: owner-regen tests — collectInvalidatedGenerators, generated-path probes, runArchiveRegen (AC-1/AC-7 evidence).</item>
  <item>RFC-1528: extract dry-run regen gate for AC-6 evidence

shouldRunArchiveRegen makes the report-only contract a tested unit instead of an inline closure check.</item>
  <item>RFC-1528: close review findings — manifest-union command inventory for regen/preflight</item>
  <history>RFC-1230</history>
</CHANGE_SUMMARY>
*/

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  collectLiveMergeTargets,
  classifyLiveMergeOutcome,
  liveMergeFailureEntry,
  formatLiveMergeFailure,
  buildLiveMergeBlock,
} from "../spec/live-spec-shared.ts";
import {
  collectInvalidatedGenerators,
  isGeneratedContent,
  isGeneratedPathName,
  runArchiveRegen,
  shouldRunArchiveRegen,
} from "./archive-regen.ts";
import type { ForgeRegisteredCommandInfo, ForgeRuntimeContext } from "../../src/types.ts";

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
    if (outcome.kind !== "merged") throw new Error("unreachable");

    const block = buildLiveMergeBlock([outcome.entry], [], 0, false);
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

// ── RFC-1528: owner-regen selection + invoke seam ─────────────────────────

function cmd(
  name: string,
  reads: string[],
  writes: string[] = [],
  generates: Array<{ path: string }> = [],
): ForgeRegisteredCommandInfo {
  return {
    name,
    description: "",
    scope: "workspace",
    provider: "workspace",
    reads,
    writes,
    generates: generates.map((g) => ({ path: g.path, phase: "on-demand" as const })),
  };
}

const GENERATED = new Set(["docs/rfcs/index.yaml", "docs/ecosystem.generated.yaml"]);
const probe = (p: string) => GENERATED.has(p) || p.includes(".generated.");

describe("docs.archive owner-regen selection (RFC-1528 AC-1)", () => {
  const registry = [
    cmd("rfc.index.generate", ["docs/rfcs/**/*.md"], ["docs/rfcs/index.yaml"]),
    cmd(
      "ecosystem.manifest.generate",
      ["pnpm-workspace.yaml", "docs/rfcs/**/*.md"],
      ["docs/ecosystem.generated.yaml"],
    ),
    cmd("rfc.create", ["docs/rfcs/**/*.md"], ["docs/rfcs/*.md"]),
    cmd("friction.append", ["docs/frictions.yaml"], ["docs/frictions.yaml"]),
    cmd("agents.generate", [], [], [{ path: "AGENTS.md" }]),
  ];

  it("selects owners whose reads[] match a moved path — non-generated writers excluded", () => {
    const selection = collectInvalidatedGenerators(
      ["docs/rfcs/rfc-1505-x.md", "docs/rfcs/archive/implemented/rfc-1505-x.md"],
      registry,
      probe,
    );
    expect(selection.map((s) => s.command)).toEqual([
      "rfc.index.generate",
      "ecosystem.manifest.generate",
    ]);
  });

  it("does not select owners when moves stay outside their reads[]", () => {
    const selection = collectInvalidatedGenerators(
      ["docs/adrs/adr-0120.md", "docs/adrs/archive/adr-0120.md"],
      registry,
      probe,
    );
    expect(selection).toEqual([]);
  });

  it("always runs ecosystem.manifest.generate last — it hashes sibling artifacts", () => {
    const reordered = [...registry].reverse();
    const selection = collectInvalidatedGenerators(["docs/rfcs/rfc-1.md"], reordered, probe);
    expect(selection.at(-1)?.command).toBe("ecosystem.manifest.generate");
  });

  it("generates[].path counts as ownership even when the path fails the file probe", () => {
    const selection = collectInvalidatedGenerators(
      ["missions/m0001/workpiece/x.md"],
      [
        cmd(
          "mission.manifest.generate",
          ["missions/**"],
          [],
          [{ path: "docs/missions.generated.yaml" }],
        ),
      ],
      () => false,
    );
    expect(selection).toHaveLength(1);
    expect(selection[0]!.command).toBe("mission.manifest.generate");
  });

  it("never selects docs.archive itself", () => {
    const selection = collectInvalidatedGenerators(
      ["docs/rfcs/rfc-1.md"],
      [cmd("docs.archive", ["docs/rfcs/**/*.md"], ["docs/rfcs/index.yaml"])],
      probe,
    );
    expect(selection).toEqual([]);
  });
});

describe("docs.archive regen gate (RFC-1528 AC-6)", () => {
  it("a --dry-run invocation is report-only — never invokes owner generators", () => {
    expect(shouldRunArchiveRegen(true, 3)).toBe(false);
    expect(shouldRunArchiveRegen(false, 3)).toBe(true);
    expect(shouldRunArchiveRegen(false, 0)).toBe(false);
  });
});

describe("docs.archive generated-path probes (RFC-1528)", () => {
  it("recognizes the .generated. infix, the marker, and the command:/generatedAt: header", () => {
    expect(isGeneratedPathName("docs/ecosystem.generated.yaml")).toBe(true);
    expect(isGeneratedPathName("docs/rfcs/index.yaml")).toBe(false);

    expect(
      isGeneratedContent(
        "# GENERATED. Do not change this line unless the file contains project specific changes.\nx",
      ),
    ).toBe(true);
    expect(
      isGeneratedContent("command: rfc.index.generate\ngeneratedAt: 2026-11-07\ncount: 3\n"),
    ).toBe(true);
    expect(isGeneratedContent("id: RFC-0001\nstatus: draft\n")).toBe(false);
  });
});

describe("docs.archive runArchiveRegen (RFC-1528 AC-1/AC-7)", () => {
  function makeContext(invoke?: ForgeRuntimeContext["invoke"]): ForgeRuntimeContext {
    return {
      workspaceRoot: "/tmp/x",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      outputFormat: "json",
      commandRegistry: {
        listCommands: () => registryCmds,
        listCommandNames: () => [],
        getCommand: () => undefined,
      },
      invoke,
    } as unknown as ForgeRuntimeContext;
  }

  const registryCmds = [
    cmd("rfc.index.generate", ["docs/rfcs/**/*.md"], ["docs/rfcs/index.yaml"]),
    cmd("ecosystem.manifest.generate", ["docs/rfcs/**/*.md"], ["docs/ecosystem.generated.yaml"]),
  ];
  const moved = ["docs/rfcs/rfc-1505-x.md"];

  it("invokes each owner with the flags map and reports regenerated paths", async () => {
    const calls: Array<{ name: string; flags?: Record<string, unknown> }> = [];
    const outcome = await runArchiveRegen({
      movedPaths: moved,
      context: makeContext(async (name, flags) => {
        calls.push({ name, flags: flags as Record<string, unknown> });
        return {
          ok: true,
          exitCode: 0,
          filesModified:
            name === "rfc.index.generate"
              ? ["docs/rfcs/index.yaml"]
              : ["docs/ecosystem.generated.yaml"],
        };
      }),
      isGeneratedPath: probe,
    });

    expect(calls).toEqual([
      { name: "rfc.index.generate", flags: { write: true } },
      { name: "ecosystem.manifest.generate", flags: {} },
    ]);
    expect(outcome.regenerated).toEqual(["docs/rfcs/index.yaml", "docs/ecosystem.generated.yaml"]);
    expect(outcome.failures).toEqual([]);
  });

  it("absent invoke → all candidates skipped, zero invokes, no failure", async () => {
    const outcome = await runArchiveRegen({
      movedPaths: moved,
      context: makeContext(undefined),
      isGeneratedPath: probe,
    });
    expect(outcome.invoked).toEqual([]);
    expect(outcome.skipped).toEqual(["rfc.index.generate", "ecosystem.manifest.generate"]);
    expect(outcome.skipReason).toBe("no-invoke");
    expect(outcome.failures).toEqual([]);
  });

  it("owner failure is recorded and later owners still run", async () => {
    const outcome = await runArchiveRegen({
      movedPaths: moved,
      context: makeContext(async (name) =>
        name === "rfc.index.generate"
          ? { ok: false, exitCode: 1, summary: "RFC-IDX-04 unparseable" }
          : { ok: true, exitCode: 0, filesModified: ["docs/ecosystem.generated.yaml"] },
      ),
      isGeneratedPath: probe,
    });
    expect(outcome.failures).toEqual([
      { command: "rfc.index.generate", error: "RFC-IDX-04 unparseable" },
    ]);
    expect(outcome.invoked).toEqual(["ecosystem.manifest.generate"]);
    expect(outcome.regenerated).toEqual(["docs/ecosystem.generated.yaml"]);
  });

  it("empty filesModified falls back to the invalidated declared paths (AC-7)", async () => {
    const outcome = await runArchiveRegen({
      movedPaths: moved,
      context: makeContext(async () => ({ ok: true, exitCode: 0 })),
      isGeneratedPath: probe,
    });
    expect(outcome.regenerated).toEqual(["docs/rfcs/index.yaml", "docs/ecosystem.generated.yaml"]);
  });

  it("werkstatt run host shape — no commandRegistry, manifest-derived inventory still regens", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "archive-regen-"));
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(
      path.join(root, "docs", "command-manifest.generated.yaml"),
      [
        "commands:",
        "  - name: ecosystem.manifest.generate",
        "    module: checks/ecosystem/manifest",
        "    reads: ['docs/rfcs/**/*.md']",
        "    writes: ['docs/ecosystem.generated.yaml']",
        "",
      ].join("\n"),
    );
    const calls: string[] = [];
    const context = {
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      outputFormat: "json",
      invoke: async (name: string) => {
        calls.push(name);
        return { ok: true, exitCode: 0, filesModified: ["docs/ecosystem.generated.yaml"] };
      },
    } as unknown as ForgeRuntimeContext;

    const outcome = await runArchiveRegen({
      movedPaths: moved,
      context,
      isGeneratedPath: probe,
    });
    expect(calls).toEqual(["ecosystem.manifest.generate"]);
    expect(outcome.regenerated).toEqual(["docs/ecosystem.generated.yaml"]);
  });
});
