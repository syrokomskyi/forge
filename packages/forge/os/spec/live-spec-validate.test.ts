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
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runSpecLiveValidate } from "./live-spec-validate.ts";
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

function archivedRfc(id: string, liveSpec = true) {
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

### Section

Body.
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
    await fs.writeFile(
      path.join(tmpDir, "docs/specs/live/forge.md"),
      specFixture({
        domain: "forge",
        lastMergedRfc: "RFC-9002",
        historyEntries:
          ENTRY_9001 +
          "  - rfc: RFC-9002\n    mergedAt: 2026-08-07\n    operation: modified\n",
        sections: [
          "### Alpha (RFC-9001)\n\na.",
          "```md\n### Alpha (RFC-9001)\n### Alpha (RFC-9001)\n```",
          "~~~\n### Beta (RFC-9002)\n~~~",
          "### Beta (RFC-9002)\n\nb.",
        ].join("\n\n"),
      }),
    );

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const v6 = result.data?.violations.filter((v) => v.rule === "V-LS-06") ?? [];
    // Fence-interior occurrences do not count — both real headings are unique.
    expect(v6).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("produces no V-LS-06/07/08 on a clean spec", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/specs/live/forge.md"),
      specFixture({
        domain: "forge",
        lastMergedRfc: "RFC-9002",
        historyEntries:
          "  - rfc: RFC-9001\n    mergedAt: 2026-08-06\n    operation: created\n" +
          "  - rfc: RFC-9002\n    mergedAt: 2026-08-07\n    operation: modified\n",
        sections: "### Alpha (RFC-9001)\n\na.\n\n### Beta (RFC-9002)\n\nb.",
      }),
    );

    const result = await runSpecLiveValidate({ argv: [], flags: {} }, makeContext(tmpDir));
    const dupOrGap = result.data?.violations.filter((v) =>
      ["V-LS-06", "V-LS-07", "V-LS-08"].includes(v.rule),
    ) ?? [];
    expect(dupOrGap).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
