/*
<MODULE_CONTRACT>
<purpose>Unit tests for spec.live.rebuild handler — dedup-replay of history[],
unreadable-RFC tolerance, unchanged/skipped operations, dry-run (RFC-1230).</purpose>
<non-goals>
  <item>Do not test spec.live.merge — covered by live-spec-merge.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1230: initial unit tests for spec.live.rebuild.</item>
  <item>RFC-1230: step 2 — spec.live.rebuild command

New workspace command deduplicates history[] and replays source RFCs deterministically (namespace headings, preserve first mergedAt/operation and createdAt, unchanged → no write, empty history → skipped). Missing/unreadable/non-implemented/design-less RFCs warn into unreadableRfcs and never abort. --domain selects one spec; absent selector (or kernel-consumed --all via supportsAllSites) rebuilds all.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com></item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runSpecLiveMerge } from "./live-spec-merge.ts";
import { runSpecLiveRebuild } from "./live-spec-rebuild.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../src/types.ts";

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  };
}

function rfcFixture(id: string, extraFrontmatter = "", designBody = "### Heading A\n\nBody.") {
  return `---
id: ${id}
title: "Test RFC ${id}"
status: implemented
kind: architecture
scope: workspace
owners:
  - architecture
reviewers:
  - human:test
createdAt: 2026-08-06
updatedAt: 2026-08-06
implementedAt: 2026-08-06
versionBump: patch
liveSpec: true
packagesImpacted:
  - packages/forge${extraFrontmatter}
commands:
  proposed: []
  added: []
  changed: []
  removed: []
appsImpacted: []
successSignals: []
nonGoals: []
---

# ${id}: Test RFC

## Design

${designBody}

## Rollout

Done.
`;
}

async function setupWorkspace(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-rebuild-"));
  const rfcDir = path.join(tmpDir, "docs/rfcs");
  await fs.mkdir(rfcDir, { recursive: true });
  await fs.writeFile(
    path.join(rfcDir, "rfc-9001-first.md"),
    rfcFixture("RFC-9001", "", "### CLI surface\n\ncli body.\n\n### Types\n\ntypes body."),
  );
  await fs.writeFile(
    path.join(rfcDir, "rfc-9004-second.md"),
    rfcFixture("RFC-9004", "", "### Other\n\nother body."),
  );
  // RFC-9006 exists but lacks ## Design — exercises the unreadable/skip path.
  await fs.writeFile(
    path.join(rfcDir, "rfc-9006-no-design.md"),
    rfcFixture("RFC-9006").replace("## Design\n\n### Heading A\n\nBody.", "## Context\n\nNo design here."),
  );
  return tmpDir;
}

async function cleanupWorkspace(tmpDir: string): Promise<void> {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

const SPEC_FILE = "docs/specs/live/forge.md";

async function corruptSpec(tmpDir: string): Promise<void> {
  const specFile = path.join(tmpDir, SPEC_FILE);
  const corrupted = (await fs.readFile(specFile, "utf-8"))
    .replace(
      "### CLI surface (RFC-9001)\n\ncli body.",
      "### CLI surface (RFC-9001)\n\ncli body.\n\n### CLI surface (RFC-9001)\n\nstale duplicate.",
    )
    .replace(
      "  - rfc: RFC-9004",
      "  - rfc: RFC-9001\n    mergedAt: 2026-08-07\n    operation: modified\n  - rfc: RFC-9004",
    );
  await fs.writeFile(specFile, corrupted);
}

describe("spec.live.rebuild", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await setupWorkspace();
    // Seed a clean spec via the real merge path.
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9001" } }, makeContext(tmpDir));
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9004" } }, makeContext(tmpDir));
  });

  afterEach(async () => {
    await cleanupWorkspace(tmpDir);
  });

  it("repairs duplicated sections and history entries by replay (AC-4)", async () => {
    await corruptSpec(tmpDir);

    const result = await runSpecLiveRebuild(
      { argv: [], flags: { domain: "forge" } },
      makeContext(tmpDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      command: "spec.live.rebuild",
      domain: "forge",
      operation: "rebuilt",
      uniqueRfcs: 2,
      droppedHistoryEntries: 1,
      droppedSections: 1,
      unreadableRfcs: [],
    });

    const content = await fs.readFile(path.join(tmpDir, SPEC_FILE), "utf-8");
    expect(content).not.toContain("stale duplicate");
    expect(content.match(/\(RFC-9001\)/g)?.length).toBe(2);
    expect(content.match(/\(RFC-9004\)/g)?.length).toBe(1);
    expect(content.match(/rfc: RFC-9001/g)?.length).toBe(1);
    expect(content.match(/rfc: RFC-9004/g)?.length).toBe(1);
    expect(content).toContain("lastMergedRfc: RFC-9004");
  });

  it("reports unchanged when a clean spec regenerates identically", async () => {
    const result = await runSpecLiveRebuild(
      { argv: [], flags: { domain: "forge" } },
      makeContext(tmpDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ operation: "unchanged", uniqueRfcs: 2 });
  });

  it("rebuild is idempotent — a second run after repair reports unchanged", async () => {
    await corruptSpec(tmpDir);
    await runSpecLiveRebuild({ argv: [], flags: { domain: "forge" } }, makeContext(tmpDir));
    const second = await runSpecLiveRebuild(
      { argv: [], flags: { domain: "forge" } },
      makeContext(tmpDir),
    );
    expect(second.exitCode).toBe(0);
    expect(second.data).toMatchObject({ operation: "unchanged" });
  });

  it("warns and continues on unreadable/missing RFCs, listing unreadableRfcs (AC-8)", async () => {
    const specFile = path.join(tmpDir, SPEC_FILE);
    const content = await fs.readFile(specFile, "utf-8");
    await fs.writeFile(
      specFile,
      content
        .replace(
          "### CLI surface (RFC-9001)\n\ncli body.",
          "### CLI surface (RFC-9001)\n\ncli body.\n\n### CLI surface (RFC-9001)\n\nstale duplicate.",
        )
        .replace(
          "  - rfc: RFC-9004",
          "  - rfc: RFC-9006\n    mergedAt: 2026-08-07\n    operation: modified\n  - rfc: RFC-9999\n    mergedAt: 2026-08-08\n    operation: modified\n  - rfc: RFC-9004",
        ),
    );

    const result = await runSpecLiveRebuild(
      { argv: [], flags: { domain: "forge" } },
      makeContext(tmpDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      operation: "rebuilt",
      unreadableRfcs: ["RFC-9006", "RFC-9999"],
    });

    const after = await fs.readFile(specFile, "utf-8");
    expect(after).toContain("rfc: RFC-9006");
    expect(after).toContain("rfc: RFC-9999");
    expect(after).not.toContain("(RFC-9006)");
    expect(after).toContain("lastMergedRfc: RFC-9004");
  });

  it("writes nothing under --dry-run (AC-9)", async () => {
    await corruptSpec(tmpDir);
    const specFile = path.join(tmpDir, SPEC_FILE);
    const before = await fs.readFile(specFile, "utf-8");

    const ctx = makeContext(tmpDir);
    ctx.dryRun = true;
    const result = await runSpecLiveRebuild(
      { argv: [], flags: { domain: "forge", "dry-run": true } },
      ctx,
    );

    expect(result.data).toMatchObject({ operation: "rebuilt", dryRun: true });
    expect(await fs.readFile(specFile, "utf-8")).toBe(before);
  });

  it("defaults to all specs when no selector is given; rejects --domain + --all", async () => {
    // Under `werkstatt run` the kernel consumes --all as its site selector —
    // "no --domain" is therefore the all-specs signal there (supportsAllSites).
    const bare = await runSpecLiveRebuild({ argv: [], flags: {} }, makeContext(tmpDir));
    expect(bare.exitCode).toBe(0);
    expect((bare.data as { domains: unknown[] }).domains.length).toBe(1);

    const both = await runSpecLiveRebuild(
      { argv: [], flags: { domain: "forge", all: true } },
      makeContext(tmpDir),
    );
    expect(both.exitCode).toBe(1);
  });

  it("exits 1 when --domain names a nonexistent spec", async () => {
    const result = await runSpecLiveRebuild(
      { argv: [], flags: { domain: "nonexistent" } },
      makeContext(tmpDir),
    );
    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("not found");
  });

  it("reports skipped for a spec with empty history", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/specs/live/empty.md"),
      `---\ndomain: empty\ntitle: "Living Spec: empty"\nlastMergedRfc: ""\nupdatedAt: 2026-08-06\ncreatedAt: 2026-08-06\nhistory: []\n---\n\n# Living Spec: empty\n\n## Overview\n`,
    );
    const result = await runSpecLiveRebuild(
      { argv: [], flags: { all: true } },
      makeContext(tmpDir),
    );
    expect(result.exitCode).toBe(0);
    const domains = (result.data as { domains: Array<{ domain: string; operation: string }> }).domains;
    expect(domains.find((d) => d.domain === "empty")?.operation).toBe("skipped");
    expect(domains.find((d) => d.domain === "forge")?.operation).toBe("unchanged");
  });
});
