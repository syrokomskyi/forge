/*
<MODULE_CONTRACT>
<purpose>Unit tests for spec.live.validate — V-LS-06 (duplicate namespaced
headings), V-LS-07 (duplicate history RFCs), V-LS-08 (archive coverage) on
synthetic living-spec fixtures (RFC-1230).</purpose>
<non-goals>
  <item>Do not re-test V-LS-01..05 semantics beyond fixtures needed for isolation.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1230: initial unit tests for V-LS-06/07/08.</item>
  <item>RFC-1230: review findings — scoped droppedSections to namespaced headings, warn on unreadable spec, fail-fast merge on corrupt frontmatter, CHANGE_SUMMARY dedupe</item>
  <item>RFC-1234: V-LS-09 drift fixtures (AC-1..3); clean/fence fixtures now produced by runSpecLiveMerge so spec bytes are canonical under replay comparison.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runSpecLiveValidate } from "./live-spec-validate.ts";
import { runSpecLiveMerge } from "./live-spec-merge.ts";
import type { ForgeRuntimeContext } from "../../src/types.ts";

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

function archivedRfc(id: string, liveSpec = true, design = "### Section\n\nBody.") {
  return `---
id: ${id}
title: "Archived RFC ${id}"
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
${liveSpec ? "liveSpec: true\n" : ""}packagesImpacted:
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

# ${id}

## Design

${design}
`;
}

function specFixture(opts: {
  domain: string;
  historyEntries: string;
  lastMergedRfc: string;
  sections: string;
}) {
  return `---
domain: ${opts.domain}
title: "Living Spec: ${opts.domain}"
lastMergedRfc: ${opts.lastMergedRfc}
updatedAt: 2026-08-06
createdAt: 2026-08-06
history:
${opts.historyEntries}---

# Living Spec: ${opts.domain}

## Overview

${opts.sections}
`;
}

const ENTRY_9001 = "  - rfc: RFC-9001\n    mergedAt: 2026-08-06\n    operation: created\n";

async function setupWorkspace(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-validate-"));
  const rfcDir = path.join(tmpDir, "docs/rfcs/archive/implemented");
  await fs.mkdir(rfcDir, { recursive: true });
  await fs.writeFile(path.join(rfcDir, "rfc-9001-merged.md"), archivedRfc("RFC-9001"));
  await fs.writeFile(path.join(rfcDir, "rfc-9002-unmerged.md"), archivedRfc("RFC-9002"));
  await fs.mkdir(path.join(tmpDir, "docs/specs/live"), { recursive: true });
  return tmpDir;
}

describe("spec.live.validate (V-LS-06/07/08)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await setupWorkspace();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("emits V-LS-06 per extra occurrence of a duplicated namespaced heading", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/specs/live/forge.md"),
      specFixture({
        domain: "forge",
        lastMergedRfc: "RFC-9001",
        historyEntries: ENTRY_9001,
        sections: [
          "### Alpha (RFC-9001)\n\na.",
          "### Alpha (RFC-9001)\n\nstale.",
          "### Alpha (RFC-9001)\n\nstalest.",
        ].join("\n\n"),
      }),
    );

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const v6 = result.data?.violations.filter((v) => v.rule === "V-LS-06") ?? [];
    // 3 occurrences → 2 "extra occurrence" diagnostics.
    expect(v6.length).toBe(2);
    expect(v6[0]?.message).toContain("Alpha (RFC-9001)");
    expect(v6[0]?.message).toContain("spec.live.rebuild");
  });

  it("emits V-LS-07 once per duplicated history rfc", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/specs/live/forge.md"),
      specFixture({
        domain: "forge",
        lastMergedRfc: "RFC-9001",
        historyEntries:
          "  - rfc: RFC-9001\n    mergedAt: 2026-08-06\n    operation: created\n" +
          "  - rfc: RFC-9001\n    mergedAt: 2026-08-07\n    operation: modified\n",
        sections: "### Alpha (RFC-9001)\n\na.",
      }),
    );

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const v7 = result.data?.violations.filter((v) => v.rule === "V-LS-07") ?? [];
    expect(v7.length).toBe(1);
    expect(v7[0]?.message).toContain("RFC-9001");
    expect(v7[0]?.message).toContain("spec.live.rebuild");
  });

  it("emits V-LS-08 when an archived implemented liveSpec RFC is absent from history", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/specs/live/forge.md"),
      specFixture({
        domain: "forge",
        lastMergedRfc: "RFC-9001",
        historyEntries: ENTRY_9001,
        sections: "### Alpha (RFC-9001)\n\na.",
      }),
    );

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const v8 = result.data?.violations.filter((v) => v.rule === "V-LS-08") ?? [];
    // RFC-9002 is archived+implemented+liveSpec but never merged into forge.md.
    expect(v8.length).toBe(1);
    expect(v8[0]?.message).toContain("RFC-9002");
    expect(v8[0]?.message).toContain("spec.live.merge --id RFC-9002");
  });

  it("emits V-LS-08 when the domain spec file is missing entirely", async () => {
    // No spec file at all — both RFCs lack coverage for domain "forge".
    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const v8 = result.data?.violations.filter((v) => v.rule === "V-LS-08") ?? [];
    expect(v8.length).toBe(2);
    expect(v8[0]?.message).toContain("does not exist");
  });

  it("does not emit V-LS-06 for ### (RFC-NNNN) lines inside fenced blocks (RFC-1232 AC-2)", async () => {
    // The spec is produced by the real merge writer so V-LS-09 sees a
    // byte-canonical file — fence-interior ### lines come from RFC-9001's
    // Design and replay identically.
    const fencedDesign = [
      "### Alpha",
      "",
      "a.",
      "",
      "```md",
      "### Alpha (RFC-9001)",
      "### Alpha (RFC-9001)",
      "```",
      "",
      "~~~",
      "### Beta (RFC-9002)",
      "~~~",
    ].join("\n");
    await fs.writeFile(
      path.join(tmpDir, "docs/rfcs/archive/implemented/rfc-9001-merged.md"),
      archivedRfc("RFC-9001", true, fencedDesign),
    );
    await fs.writeFile(
      path.join(tmpDir, "docs/rfcs/archive/implemented/rfc-9002-unmerged.md"),
      archivedRfc("RFC-9002", true, "### Beta\n\nb."),
    );

    const ctx = makeContext(tmpDir);
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9001" } }, ctx);
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9002" } }, ctx);

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, ctx);
    const v6 = result.data?.violations.filter((v) => v.rule === "V-LS-06") ?? [];
    // Fence-interior occurrences do not count — both real headings are unique.
    expect(v6).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("produces no V-LS-06/07/08 on a clean spec", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/rfcs/archive/implemented/rfc-9001-merged.md"),
      archivedRfc("RFC-9001", true, "### Alpha\n\na."),
    );
    await fs.writeFile(
      path.join(tmpDir, "docs/rfcs/archive/implemented/rfc-9002-unmerged.md"),
      archivedRfc("RFC-9002", true, "### Beta\n\nb."),
    );
    const ctx = makeContext(tmpDir);
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9001" } }, ctx);
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9002" } }, ctx);

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, ctx);
    const dupOrGap = result.data?.violations.filter((v) =>
      ["V-LS-06", "V-LS-07", "V-LS-08"].includes(v.rule),
    ) ?? [];
    expect(dupOrGap).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

describe("spec.live.validate (V-LS-09 content drift — RFC-1234)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await setupWorkspace();
    await fs.writeFile(
      path.join(tmpDir, "docs/rfcs/archive/implemented/rfc-9001-merged.md"),
      archivedRfc("RFC-9001", true, "### Alpha\n\na."),
    );
    await fs.writeFile(
      path.join(tmpDir, "docs/rfcs/archive/implemented/rfc-9002-unmerged.md"),
      archivedRfc("RFC-9002", true, "### Beta\n\nb."),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function mergedSpec(): Promise<string> {
    const ctx = makeContext(tmpDir);
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9001" } }, ctx);
    await runSpecLiveMerge({ argv: [], flags: { id: "RFC-9002" } }, ctx);
    return path.join(tmpDir, "docs/specs/live/forge.md");
  }

  it("AC-1: emits a V-LS-09 error naming the domain and repair path on drift", async () => {
    const specPath = await mergedSpec();
    await fs.appendFile(specPath, "\nStale hand edit.\n");

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const v9 = result.data?.violations.filter((v) => v.rule === "V-LS-09") ?? [];
    expect(v9.length).toBe(1);
    expect(v9[0]?.severity).toBe("error");
    expect(v9[0]?.message).toContain("forge.md");
    expect(v9[0]?.message).toContain("spec.live.rebuild --domain forge");
    expect(result.exitCode).toBe(1);
  });

  it("AC-2: emits no V-LS-09 when the spec matches its replay", async () => {
    await mergedSpec();
    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const v9 = result.data?.violations.filter((v) => v.rule === "V-LS-09") ?? [];
    expect(v9).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("AC-3: warns on an unreadable history RFC and still runs the drift comparison", async () => {
    await mergedSpec();
    // Deleting the RFC file leaves history[] pointing at an unreadable id —
    // replay skips it, so the spec's RFC-9002 sections are unreproducible.
    await fs.rm(path.join(tmpDir, "docs/rfcs/archive/implemented/rfc-9002-unmerged.md"));

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const v9warn = result.data?.violations.filter(
      (v) => v.rule === "V-LS-09" && v.severity === "warning",
    ) ?? [];
    expect(v9warn.length).toBe(1);
    expect(v9warn[0]?.message).toContain("RFC-9002");
    // The drift comparison still ran — the un-replayable body diverges.
    const v9err = result.data?.violations.filter(
      (v) => v.rule === "V-LS-09" && v.severity === "error",
    ) ?? [];
    expect(v9err.length).toBe(1);
    expect(result.exitCode).toBe(1);
  });
});
