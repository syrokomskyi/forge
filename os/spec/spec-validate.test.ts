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

describe("spec.validate consumer rules (RFC-1240)", () => {
  async function writeConsumerSpec(workspaceRoot: string, consumersYaml: string): Promise<void> {
    const specDir = path.join(workspaceRoot, "docs/specs/example");
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(path.join(specDir, "forge-spec.yaml"), `schema: forge/spec@1
id: example
title: Example
version: 1.0.0
status: accepted
reviewers: []
sourceNote: test fixture
vendoredAt: 2026-10-09
documents: {}
decisions: []
rfcs:
  - id: EX-001
    title: Consumer node
    dependsOn: []
    wave: 1
    sources: []
${consumersYaml}waves:
  - id: 1
    name: Test
    goal: Exercise consumer rules
`);
    await fs.writeFile(path.join(specDir, "integrity.yaml"), "schema: forge/spec-integrity@1\nfiles: {}\n");
  }

  function ctx(workspaceRoot: string): ForgeRuntimeContext {
    return { workspaceRoot, dryRun: false, outputFormat: "json",
      logger: { section() {}, info() {}, warn() {}, error() {}, success() {} } } as ForgeRuntimeContext;
  }

  it("emits SPEC-13 warning without failing when consumers exist but no local identity is configured", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-consumer-"));
    roots.push(workspaceRoot);
    await writeConsumerSpec(workspaceRoot, "    consumers:\n      - personal-agent\n");
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data.status).toBe("pass");
    const warnings = result.data.specs[0]!.violations.filter((v) => v.severity === "warning");
    expect(warnings.map((v) => v.rule)).toEqual(["SPEC-13"]);
    expect(warnings[0]!.message).toContain("EX-001");
  });

  it("does not emit SPEC-13 when project.consumer is configured", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-consumer-"));
    roots.push(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, "forge.yaml"),
      "schema: forge/config@1\nproject:\n  name: test-ws\n  consumer: werkstatt\npaths: {}\n");
    await writeConsumerSpec(workspaceRoot, "    consumers:\n      - personal-agent\n");
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data.specs[0]!.violations).toEqual([]);
  });

  it("fails with SPEC-12 on duplicate consumer entries", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-consumer-"));
    roots.push(workspaceRoot);
    await writeConsumerSpec(workspaceRoot, "    consumers:\n      - werkstatt\n      - werkstatt\n");
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data.specs[0]!.violations.map((v) => v.rule)).toContain("SPEC-12");
  });
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
