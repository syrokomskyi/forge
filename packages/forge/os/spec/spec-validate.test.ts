/*
<MODULE_CONTRACT>
<purpose>Prove vendored spec validation resolves materialized RFCs across the canonical RFC archive topology.</purpose>
<non-goals><item>Do not duplicate individual integrity, graph, or amendment rule tests.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY><item>Gap fix: cover SPEC-07 after terminal RFC archival.</item></CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeRuntimeContext } from "../../src/types.ts";
import { runSpecValidate } from "./spec-validate.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("spec.validate SPEC-07", () => {
  it("accepts a materialized RFC after docs.archive moves it below archive/implemented", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-archive-"));
    roots.push(workspaceRoot);
    const specDir = path.join(workspaceRoot, "docs/specs/example");
    const archiveDir = path.join(workspaceRoot, "docs/rfcs/archive/implemented");
    await fs.mkdir(specDir, { recursive: true }); await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, "rfc-9001-example.md"), "---\nid: RFC-9001\n---\n");
    await fs.writeFile(path.join(specDir, "forge-spec.yaml"), `schema: forge/spec@1
id: example
title: Example
version: 1.0.0
status: accepted
reviewers: []
sourceNote: test fixture
vendoredAt: 2026-09-03
documents: {}
decisions: []
rfcs:
  - id: EX-001
    title: Archived RFC
    dependsOn: []
    wave: 1
    sources: []
    materializedAs: RFC-9001
waves:
  - id: 1
    name: Test
    goal: Exercise archived resolution
`);
    await fs.writeFile(path.join(specDir, "integrity.yaml"), "schema: forge/spec-integrity@1\nfiles: {}\n");
    const context = { workspaceRoot, dryRun: false, outputFormat: "json",
      logger: { section() {}, info() {}, warn() {}, error() {}, success() {} } } as ForgeRuntimeContext;
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, context);
    expect(result).toMatchObject({ exitCode: 0, data: { status: "pass",
      specs: [{ id: "example", violations: [] }] } });
  });
});
