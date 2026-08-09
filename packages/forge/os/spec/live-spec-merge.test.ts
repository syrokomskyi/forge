/*
<MODULE_CONTRACT>
<purpose>Unit tests for spec.live.merge handler — covers creation, modification,
conflict detection, dry-run, no-op cases (RFC-0711).</purpose>
<non-goals>
  <item>Do not test docs.archive integration — covered separately.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial unit tests for spec.live.merge.</item>
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

async function setupWorkspace(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-test-"));
  const rfcDir = path.join(tmpDir, "docs/rfcs");
  await fs.mkdir(rfcDir, { recursive: true });
  await fs.writeFile(path.join(rfcDir, "rfc-9001-test-rfc-for-living-specs.md"), SAMPLE_RFC);
  await fs.writeFile(path.join(rfcDir, "rfc-9002-test-rfc-without-livespec.md"), SAMPLE_RFC_NO_LIVE_SPEC);
  await fs.writeFile(path.join(rfcDir, "rfc-9003-rejected-rfc-with-livespec.md"), SAMPLE_RFC_REJECTED);
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

  it("modifies an existing living spec", async () => {
    // First merge creates the spec
    const input1: ForgeCommandInput = { argv: [], flags: { id: "RFC-9001" } };
    await runSpecLiveMerge(input1, makeContext(tmpDir));

    // Second merge modifies it
    const input2: ForgeCommandInput = { argv: [], flags: { id: "RFC-9001" } };
    const result = await runSpecLiveMerge(input2, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.operation).toBe("modified");
    expect(result.data?.domain).toBe("forge");
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
});
