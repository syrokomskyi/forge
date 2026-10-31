/*
<MODULE_CONTRACT>
<purpose>RFC-1470 context.index.build tests — unit catalog covers the required kinds (session-block, friction, rfc-header minimum); rebuild is pure projection.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runIndexBuild } from "./index-build.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";

let root: string;

function ctx(): ForgeRuntimeContext {
  return {
    workspaceRoot: root,
    outputFormat: "json",
    logger: { info() {}, warn() {}, error() {}, success() {}, section() {} },
  } as unknown as ForgeRuntimeContext;
}

function flags(f: Record<string, unknown> = {}) {
  return { argv: [], flags: f } as never;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "index-build-"));
  await mkdir(join(root, "docs", "sessions"), { recursive: true });
  await mkdir(join(root, "docs", "rfcs"), { recursive: true });
  await writeFile(join(root, "docs", "frictions.yaml"), `- id: F-0001
  friction: "test scar"
  category: process
`);
  await writeFile(join(root, "docs", "sessions", "2026-10-31-12-00-00-aaaaaa.md"), `---
id: s-test
summary: "worked on the migration path for scars"
---
body
`);
  await writeFile(join(root, "docs", "rfcs", "rfc-test.md"), `---
id: RFC-9001
title: "Test RFC for the index"
status: accepted
successSignals:
  - "the index covers the unit"
---
# Test
`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("context.index.build (RFC-1470)", () => {
  test("covers session-block + friction + rfc-header kinds", async () => {
    const res = await runIndexBuild(flags({}), ctx());
    expect(res.data?.units).toBeGreaterThan(0);
    const kinds = Object.keys(res.data?.byKind ?? {});
    expect(kinds).toContain("session-block");
    expect(kinds).toContain("friction");
    expect(kinds).toContain("rfc-header");
    const index = await readFile(join(root, "docs", ".index", "context", "index.yaml"), "utf8");
    expect(index).toContain("forge/context-index@1");
  });
});
