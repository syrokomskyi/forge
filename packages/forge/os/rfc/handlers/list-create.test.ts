/*
<MODULE_CONTRACT>
<purpose>
RFC-1467 near-duplicate gate tests — AC-1/2/3/5/8: terminal-kind
(rejected/superseded) decision-log hits at the reproposal threshold block
rfc.create until --revisit acknowledges a colliding id; the review band cites
hits via related + NEEDS CLARIFICATION; a non-colliding --revisit is refused
with candidates listed.
</purpose>
<non-goals>
  <item>Not a template-content contract — fixtures carry the minimal template shape the handler rewrites.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRfcCreate } from "./list-create.ts";

const TEMPLATE = `id: RFC-0000
title: "Template"
status: draft
kind: command
scope: workspace
owners: [architecture]
createdAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
satisfies: []
related:

# RFC-0000: Template

## Decision
`;

const REJECTED_BODY = `---
id: RFC-1312
title: "Isolate parallel agent sessions in per-session worktrees"
status: rejected
kind: architecture
scope: workspace
---

# RFC-1312: rejected

## Decision

Rejected — isolation belongs to the scheduler, not the worktree.
`;

const REJECTED_TITLE = "Isolate parallel agent sessions in per-session worktrees";

let root: string;
const context = () => ({
  workspaceRoot: root,
  dryRun: false,
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    section: () => {},
    getEvents: () => [],
  },
  outputFormat: "json" as const,
  io: undefined as never,
});

async function seed(opts: { rejected?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "rfc1467-create-"));
  const rfcDir = join(root, "docs", "rfcs");
  await mkdir(join(rfcDir, "archive", "rejected"), { recursive: true });
  await writeFile(join(rfcDir, "rfc-0000-template.md"), TEMPLATE);
  if (opts.rejected !== false) {
    await writeFile(join(rfcDir, "archive", "rejected", "rfc-1312-test.md"), REJECTED_BODY);
  }
  return root;
}

const flags = (extra: Record<string, unknown> = {}) => ({
  title: REJECTED_TITLE,
  kind: "command",
  scope: "workspace",
  ...extra,
});

describe("RFC-1467 rfc.create near-duplicate gate", () => {
  beforeEach(async () => {
    await seed();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("AC-2: a terminal hit at the reproposal threshold blocks without --revisit", async () => {
    const result = await runRfcCreate({ flags: flags() } as never, context());
    expect(result.exitCode).toBe(1);
    expect(result.data?.blocked).toBe(true);
    expect(result.data?.status).toBe("blocked");
    expect(result.data?.colliding).toEqual(["RFC-1312"]);
    expect(result.data?.remedy).toContain("--revisit RFC-1312");
    // AC-1: the escalation payload accompanies consultedDecisions in JSON.
    expect(Array.isArray(result.data?.consultedDecisions)).toBe(true);
  });

  test("AC-3: --revisit scaffolds with related + NEEDS CLARIFICATION marker", async () => {
    const result = await runRfcCreate(
      { flags: flags({ revisit: "RFC-1312" }) } as never,
      context(),
    );
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.data?.status).toBe("ok");
    const body = await readFile(join(root, result.data!.file!), "utf8");
    expect(body).toContain("  - RFC-1312");
    expect(body).toContain("> NEEDS CLARIFICATION:");
    expect(body).toContain("RFC-1312 is a rejected/superseded precedent");
  });

  test("AC-8: --revisit naming a non-colliding id refuses and lists candidates", async () => {
    const result = await runRfcCreate(
      { flags: flags({ revisit: "RFC-9999" }) } as never,
      context(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.data?.blocked).toBe(true);
    expect(result.data?.remedy).toContain("RFC-1312");
  });

  test("AC-5: sub-threshold titles scaffold normally carrying consultedDecisions", async () => {
    const result = await runRfcCreate(
      { flags: flags({ title: "Rotate the cache eviction cadence" }) } as never,
      context(),
    );
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.data?.status).toBe("ok");
    expect(result.data?.colliding).toBeUndefined();
  });
});
