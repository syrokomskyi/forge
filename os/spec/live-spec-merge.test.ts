/*
<MODULE_CONTRACT>
<purpose>Unit tests for spec.live.merge handler — covers creation, modification,
idempotent already-merged skip, --force re-merge, conflict detection, dry-run,
no-op cases (RFC-0711, RFC-1230).</purpose>
<non-goals>
  <item>Do not test docs.archive integration — covered separately.</item>
  <item>Do not test spec.live.rebuild — covered by live-spec-rebuild.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial unit tests for spec.live.merge.</item>
  <item>RFC-1230: updated re-merge expectations to already-merged; added --force surgical re-merge and byte-identity cases.</item>
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runSpecLiveMerge } from "./live-spec-merge.ts";
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

const SAMPLE_RFC = `---
id: RFC-9001
title: "Test RFC for living specs"
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
  - packages/forge
commands:
  proposed: []
  added: []
  changed: []
  removed: []
appsImpacted: []
successSignals: []
nonGoals: []
---

# RFC-9001: Test RFC for living specs

## Context

Some context.

## Design

### CLI surface

\`\`\`sh
pnpm exec werkstatt run spec.live.merge --id RFC-9001
\`\`\`

### TypeScript contracts

Some types.

### File system responsibilities

Some files.

## Rollout

Some rollout.
`;

const SAMPLE_RFC_NO_LIVE_SPEC = `---
id: RFC-9002
title: "Test RFC without liveSpec"
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
packagesImpacted:
  - packages/forge
commands:
  proposed: []
  added: []
  changed: []
  removed: []
appsImpacted: []
successSignals: []
nonGoals: []
---

# RFC-9002: Test RFC without liveSpec

## Design

### Something

Content.
`;

const SAMPLE_RFC_REJECTED = `---
id: RFC-9003
title: "Rejected RFC with liveSpec"
status: rejected
kind: architecture
scope: workspace
owners:
  - architecture
reviewers:
  - human:test
createdAt: 2026-08-06
updatedAt: 2026-08-06
versionBump: patch
liveSpec: true
packagesImpacted:
  - packages/forge
commands:
  proposed: []
  added: []
  changed: []
  removed: []
appsImpacted: []
successSignals: []
nonGoals: []
---

# RFC-9003: Rejected RFC with liveSpec

## Design

### Rejected heading

Content.
`;

const SAMPLE_RFC_9004 = `---
id: RFC-9004
title: "Second RFC with same headings"
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
  - packages/forge
commands:
  proposed: []
  added: []
  changed: []
  removed: []
appsImpacted: []
successSignals: []
nonGoals: []
---

# RFC-9004: Second RFC with same headings

## Design

### CLI surface

Different CLI content from RFC-9004.

### TypeScript contracts

Different types from RFC-9004.

## Rollout

Some rollout.
`;

async function setupWorkspace(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-test-"));
  const rfcDir = path.join(tmpDir, "docs/rfcs");
  await fs.mkdir(rfcDir, { recursive: true });
  await fs.writeFile(path.join(rfcDir, "rfc-9001-test-rfc-for-living-specs.md"), SAMPLE_RFC);
  await fs.writeFile(path.join(rfcDir, "rfc-9002-test-rfc-without-livespec.md"), SAMPLE_RFC_NO_LIVE_SPEC);
  await fs.writeFile(path.join(rfcDir, "rfc-9003-rejected-rfc-with-livespec.md"), SAMPLE_RFC_REJECTED);
  await fs.writeFile(path.join(rfcDir, "rfc-9004-second-rfc-with-same-headings.md"), SAMPLE_RFC_9004);
  return tmpDir;
}

async function cleanupWorkspace(tmpDir: string): Promise<void> {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

describe("spec.live.merge", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await setupWorkspace();
  });

  afterEach(async () => {
    await cleanupWorkspace(tmpDir);
  });

  it("creates a new living spec when none exists", async () => {
    const input: ForgeCommandInput = { argv: [], flags: { id: "RFC-9001" } };
    const result = await runSpecLiveMerge(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.operation).toBe("created");
    expect(result.data?.domain).toBe("forge");
    expect(result.data?.deltas.length).toBeGreaterThan(0);
    expect(result.data?.conflicts.length).toBe(0);

    const specFile = path.join(tmpDir, "docs/specs/live/forge.md");
    const content = await fs.readFile(specFile, "utf-8");
    expect(content).toContain("domain: forge");
    expect(content).toContain("lastMergedRfc: RFC-9001");
  });

  it("skips an already-merged RFC and leaves the spec byte-identical (AC-1)", async () => {
    // First merge creates the spec
    const input1: ForgeCommandInput = { argv: [], flags: { id: "RFC-9001" } };
    await runSpecLiveMerge(input1, makeContext(tmpDir));

    const specFile = path.join(tmpDir, "docs/specs/live/forge.md");
    const before = await fs.readFile(specFile, "utf-8");

    // Second merge of the same RFC is a no-op
    const input2: ForgeCommandInput = { argv: [], flags: { id: "RFC-9001" } };
    const result = await runSpecLiveMerge(input2, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.operation).toBe("already-merged");
    expect(result.data?.domain).toBe("forge");
    expect(result.data?.deltas).toEqual([]);

    const after = await fs.readFile(specFile, "utf-8");
    expect(after).toBe(before);
  });

  it("re-merges an already-merged RFC surgically with --force (AC-2)", async () => {
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9001" } }, makeContext(tmpDir));
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9004" } }, makeContext(tmpDir));

    const specFile = path.join(tmpDir, "docs/specs/live/forge.md");

    // Simulate prior corruption: a duplicated RFC-9001 section + history entry.
    const corrupted = (await fs.readFile(specFile, "utf-8"))
      .replace(
        "### TypeScript contracts (RFC-9001)\n\nSome types.",
        "### TypeScript contracts (RFC-9001)\n\nSome types.\n\n### CLI surface (RFC-9001)\n\nDuplicated stale section.",
      )
      .replace(
        "  - rfc: RFC-9004",
        "  - rfc: RFC-9001\n    mergedAt: 2026-08-07\n    operation: modified\n  - rfc: RFC-9004",
      );
    await fs.writeFile(specFile, corrupted);

    const result = await runSpecLiveMerge(
      { argv: [], flags: { id: "RFC-9001", force: true } },
      makeContext(tmpDir),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.operation).toBe("modified");

    const after = await fs.readFile(specFile, "utf-8");
    // Exactly one section set for RFC-9001 remains; stale duplicate is gone.
    expect(after.match(/\(RFC-9001\)/g)?.length).toBe(3);
    expect(after).not.toContain("Duplicated stale section.");
    // Exactly one history entry for RFC-9001.
    expect(after.match(/rfc: RFC-9001/g)?.length).toBe(1);
    // RFC-9004 sections untouched.
    expect(after).toContain("CLI surface (RFC-9004)");
  });

  it("skips RFCs without liveSpec field (no-op)", async () => {
    const input: ForgeCommandInput = { argv: [], flags: { id: "RFC-9002" } };
    const result = await runSpecLiveMerge(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.deltas.length).toBe(0);
    expect(result.data?.domain).toBe("");
  });

  it("rejects non-implemented RFCs", async () => {
    const input: ForgeCommandInput = { argv: [], flags: { id: "RFC-9003" } };
    const result = await runSpecLiveMerge(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("rejected");
  });

  it("supports --dry-run without writing files", async () => {
    const input: ForgeCommandInput = { argv: [], flags: { id: "RFC-9001", "dry-run": true } };
    const ctx = makeContext(tmpDir);
    ctx.dryRun = true;
    const result = await runSpecLiveMerge(input, ctx);

    expect(result.exitCode).toBe(0);
    expect(result.data?.dryRun).toBe(true);
    expect(result.data?.operation).toBe("created");

    const specFile = path.join(tmpDir, "docs/specs/live/forge.md");
    await expect(fs.access(specFile)).rejects.toThrow();
  });

  it("returns error when --id is missing", async () => {
    const input: ForgeCommandInput = { argv: [], flags: {} };
    const result = await runSpecLiveMerge(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("--id");
  });

  it("returns error when RFC is not found", async () => {
    const input: ForgeCommandInput = { argv: [], flags: { id: "RFC-9999" } };
    const result = await runSpecLiveMerge(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("not found");
  });

  it("namespaces headings by RFC ID and allows multiple RFCs with same heading names", async () => {
    // First merge creates the spec with RFC-9001 headings
    const input1: ForgeCommandInput = { argv: [], flags: { id: "RFC-9001" } };
    await runSpecLiveMerge(input1, makeContext(tmpDir));

    // Second merge with RFC-9004 (same heading names) should NOT conflict
    const input2: ForgeCommandInput = { argv: [], flags: { id: "RFC-9004" } };
    const result = await runSpecLiveMerge(input2, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.conflicts.length).toBe(0);
    expect(result.data?.deltas.length).toBeGreaterThan(0);

    const specFile = path.join(tmpDir, "docs/specs/live/forge.md");
    const content = await fs.readFile(specFile, "utf-8");
    expect(content).toContain("CLI surface (RFC-9001)");
    expect(content).toContain("CLI surface (RFC-9004)");
  });

  it("reports already-merged on re-run instead of duplicating sections (RFC-1230)", async () => {
    // Initial merges
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9001" } }, makeContext(tmpDir));
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9004" } }, makeContext(tmpDir));

    // Re-merge RFC-9001 (simulates a repeated caller) — idempotent no-op
    const result = await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9001" } }, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.operation).toBe("already-merged");
    expect(result.data?.deltas).toEqual([]);
  });

  it("writes nothing under --dry-run on an existing spec (AC-9)", async () => {
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9001" } }, makeContext(tmpDir));
    const specFile = path.join(tmpDir, "docs/specs/live/forge.md");
    const before = await fs.readFile(specFile, "utf-8");

    const ctx = makeContext(tmpDir);
    ctx.dryRun = true;
    const result = await runSpecLiveMerge(
      { argv: [], flags: { id: "RFC-9001", force: true, "dry-run": true } },
      ctx,
    );

    expect(result.data?.dryRun).toBe(true);
    const after = await fs.readFile(specFile, "utf-8");
    expect(after).toBe(before);
  });

  it("fails instead of overwriting a spec with unparseable frontmatter", async () => {
    const specFile = path.join(tmpDir, "docs/specs/live/forge.md");
    await fs.mkdir(path.dirname(specFile), { recursive: true });
    const corrupt = "# Living Spec: forge\n\nno frontmatter — orphaned content\n";
    await fs.writeFile(specFile, corrupt);

    const result = await runSpecLiveMerge(
      { argv: [], flags: { id: "RFC-9001" } },
      makeContext(tmpDir),
    );

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("valid frontmatter");
    expect(await fs.readFile(specFile, "utf-8")).toBe(corrupt);
  });
});
