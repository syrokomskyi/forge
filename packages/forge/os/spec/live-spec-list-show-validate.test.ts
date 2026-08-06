/*
<MODULE_CONTRACT>
<purpose>Unit tests for spec.live.list and spec.live.validate handlers (RFC-0711).</purpose>
<non-goals>
  <item>Do not test merge — covered in live-spec-merge.test.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0711: initial unit tests for spec.live.list and spec.live.validate.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runSpecLiveList } from "./live-spec-list.ts";
import { runSpecLiveShow } from "./live-spec-show.ts";
import { runSpecLiveValidate } from "./live-spec-validate.ts";
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

const VALID_SPEC = `---
domain: forge
title: "Living Spec: forge"
lastMergedRfc: RFC-9001
updatedAt: 2026-08-06
createdAt: 2026-08-06
history:
  - rfc: RFC-9001
    mergedAt: 2026-08-06
    operation: created
---

# Living Spec: forge

## Overview

Some content.
`;

describe("spec.live.list", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-list-"));
    const liveDir = path.join(tmpDir, "docs/specs/live");
    await fs.mkdir(liveDir, { recursive: true });
    await fs.writeFile(path.join(liveDir, "forge.md"), VALID_SPEC);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists living specs", async () => {
    const input: ForgeCommandInput = { argv: [], flags: {} };
    const result = await runSpecLiveList(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.livingSpecs.length).toBe(1);
    expect(result.data?.livingSpecs[0]?.domain).toBe("forge");
    expect(result.data?.livingSpecs[0]?.lastMergedRfc).toBe("RFC-9001");
  });

  it("returns empty array when directory does not exist", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-empty-"));
    try {
      const input: ForgeCommandInput = { argv: [], flags: {} };
      const result = await runSpecLiveList(input, makeContext(emptyDir));

      expect(result.exitCode).toBe(0);
      expect(result.data?.livingSpecs.length).toBe(0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("spec.live.show", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-show-"));
    const liveDir = path.join(tmpDir, "docs/specs/live");
    await fs.mkdir(liveDir, { recursive: true });
    await fs.writeFile(path.join(liveDir, "forge.md"), VALID_SPEC);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("shows a living spec by domain", async () => {
    const input: ForgeCommandInput = { argv: [], flags: { domain: "forge" } };
    const result = await runSpecLiveShow(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.domain).toBe("forge");
    expect(result.data?.title).toBe("Living Spec: forge");
    expect(result.data?.body).toContain("# Living Spec: forge");
  });

  it("returns error when domain is missing", async () => {
    const input: ForgeCommandInput = { argv: [], flags: {} };
    const result = await runSpecLiveShow(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("--domain");
  });

  it("returns error when spec not found", async () => {
    const input: ForgeCommandInput = { argv: [], flags: { domain: "nonexistent" } };
    const result = await runSpecLiveShow(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("not found");
  });
});

describe("spec.live.validate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-validate-"));
    const rfcDir = path.join(tmpDir, "docs/rfcs");
    const liveDir = path.join(tmpDir, "docs/specs/live");
    await fs.mkdir(rfcDir, { recursive: true });
    await fs.mkdir(liveDir, { recursive: true });

    // Create an implemented RFC so V-LS-03/04 pass
    const rfcContent = `---
id: RFC-9001
title: "Test"
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
packagesImpacted: []
commands:
  proposed: []
  added: []
  changed: []
  removed: []
appsImpacted: []
successSignals: []
nonGoals: []
---

# RFC-9001: Test

## Design

### Something

Content.
`;
    await fs.writeFile(path.join(rfcDir, "rfc-9001-test.md"), rfcContent);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes with zero violations on a valid living spec", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docs/specs/live/forge.md"),
      VALID_SPEC,
    );

    const input: ForgeCommandInput = { argv: [], flags: {} };
    const result = await runSpecLiveValidate(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(0);
    expect(result.data?.status).toBe("pass");
    expect(result.data?.violations.length).toBe(0);
    expect(result.data?.specsChecked).toBe(1);
  });

  it("passes when directory does not exist (empty)", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-live-validate-empty-"));
    try {
      const input: ForgeCommandInput = { argv: [], flags: {} };
      const result = await runSpecLiveValidate(input, makeContext(emptyDir));

      expect(result.exitCode).toBe(0);
      expect(result.data?.status).toBe("pass");
      expect(result.data?.specsChecked).toBe(0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("fails when required frontmatter field is missing", async () => {
    const invalidSpec = `---
domain: forge
title: "Living Spec: forge"
---

# Living Spec: forge
`;
    await fs.writeFile(path.join(tmpDir, "docs/specs/live/forge.md"), invalidSpec);

    const input: ForgeCommandInput = { argv: [], flags: {} };
    const result = await runSpecLiveValidate(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(1);
    expect(result.data?.status).toBe("fail");
    expect(result.data?.violations.length).toBeGreaterThan(0);
    expect(result.data?.violations.some((v) => v.rule === "V-LS-01")).toBe(true);
  });

  it("fails when domain does not match filename (V-LS-02)", async () => {
    const mismatchSpec = `---
domain: wrong-domain
title: "Living Spec"
lastMergedRfc: RFC-9001
updatedAt: 2026-08-06
createdAt: 2026-08-06
history:
  - rfc: RFC-9001
    mergedAt: 2026-08-06
    operation: created
---

# Living Spec
`;
    await fs.writeFile(path.join(tmpDir, "docs/specs/live/forge.md"), mismatchSpec);

    const input: ForgeCommandInput = { argv: [], flags: {} };
    const result = await runSpecLiveValidate(input, makeContext(tmpDir));

    expect(result.exitCode).toBe(1);
    expect(result.data?.violations.some((v) => v.rule === "V-LS-02")).toBe(true);
  });
});
