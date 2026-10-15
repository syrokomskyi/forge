/*
<MODULE_CONTRACT>
<purpose>Prove vendored spec validation behaviors — consumer rules, SPEC-07 archive resolution, and sweep-mode package scoping.</purpose>
<non-goals><item>Do not duplicate individual integrity, graph, or amendment rule tests.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Gap fix: cover SPEC-07 after terminal RFC archival.</item>
  <item>Handoff xrepo-personal-agent-to-forge-spec-validate-sweep: cover sweep-mode manifest-dir scoping and skippedDirs.</item>
  <item>RFC-1302: consumer-aware SPEC-07, narrowed SPEC-10, source-first bin entry (RFC-1302)</item>
</CHANGE_SUMMARY>
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

describe("spec.validate consumer rules (RFC-1240)", () => {
  it("emits SPEC-13 warning without failing when consumers exist but no local identity is configured", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-consumer-"));
    roots.push(workspaceRoot);
    await writeConsumerSpec(workspaceRoot, "    consumers:\n      - personal-agent\n");
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data!.status).toBe("pass");
    const warnings = result.data!.specs[0]!.violations.filter((v) => v.severity === "warning");
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
    expect(result.data!.specs[0]!.violations).toEqual([]);
  });

  it("fails with SPEC-12 on duplicate consumer entries", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-consumer-"));
    roots.push(workspaceRoot);
    await writeConsumerSpec(workspaceRoot, "    consumers:\n      - werkstatt\n      - werkstatt\n");
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data!.specs[0]!.violations.map((v) => v.rule)).toContain("SPEC-12");
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

describe("spec.validate sweep scoping (xrepo-personal-agent-to-forge-spec-validate-sweep)", () => {
  it("skips dirs without forge-spec.yaml and reports them in skippedDirs", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-sweep-"));
    roots.push(workspaceRoot);
    await writeConsumerSpec(workspaceRoot, "");
    await fs.mkdir(path.join(workspaceRoot, "docs/specs/authored-draft"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "docs/specs/live"), { recursive: true });
    const result = await runSpecValidate({ argv: [], flags: {} }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(0);
    expect(result.data!.status).toBe("pass");
    expect(result.data!.specs.map((s) => s.id)).toEqual(["example"]);
    expect(result.data!.skippedDirs.sort()).toEqual(["authored-draft", "live"]);
  });

  it("passes with empty specs when every dir lacks a manifest", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-sweep-"));
    roots.push(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "docs/specs/authored-draft"), { recursive: true });
    const result = await runSpecValidate({ argv: [], flags: {} }, ctx(workspaceRoot));
    expect(result).toMatchObject({ exitCode: 0, data: { status: "pass",
      specs: [], skippedDirs: ["authored-draft"] } });
  });

  it("keeps SPEC-02 when --spec names a dir without a manifest", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-sweep-"));
    roots.push(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "docs/specs/authored-draft"), { recursive: true });
    const result = await runSpecValidate(
      { argv: [], flags: { spec: "authored-draft" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data!.specs[0]!.violations).toEqual([
      { rule: "SPEC-02", message: "forge-spec.yaml not found" },
    ]);
    expect(result.data!.skippedDirs).toEqual([]);
  });

  it("still reports SPEC-02 in sweep mode for a present-but-corrupt manifest", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-sweep-"));
    roots.push(workspaceRoot);
    const broken = path.join(workspaceRoot, "docs/specs/broken");
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(path.join(broken, "forge-spec.yaml"), "schema: [unclosed\n");
    const result = await runSpecValidate({ argv: [], flags: {} }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(1);
    expect(result.data!.skippedDirs).toEqual([]);
    expect(result.data!.specs[0]!.violations[0]!.rule).toBe("SPEC-02");
  });
});

describe("spec.validate RFC-1302 consumer-aware SPEC-07 and narrowed SPEC-10", () => {
  async function workspace(nodeExtra: string, consumer?: string): Promise<string> {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-validate-1302-"));
    roots.push(workspaceRoot);
    if (consumer) {
      await fs.writeFile(path.join(workspaceRoot, "forge.yaml"),
        `schema: forge/config@1\nproject:\n  name: test-ws\n  consumer: ${consumer}\npaths: {}\n`);
    }
    await writeConsumerSpec(workspaceRoot, nodeExtra);
    return workspaceRoot;
  }

  async function amendment(root: string, id: string, targetsYaml: string): Promise<void> {
    const dir = path.join(root, "docs/specs/example/amendments");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id.toLowerCase()}.md`), `---
schema: forge/spec-amendment@1
id: ${id}
title: ${id}
status: accepted
createdAt: 2026-10-15
reviewers:
  - human:test
targets:
${targetsYaml}discoveredBy: test
---
`);
  }

  it("skips SPEC-07 for a materialized node owned by another consumer", async () => {
    const root = await workspace("    consumers:\n      - werkstatt\n    materializedAs: RFC-9001\n", "pipelines");
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(root));
    expect(result.exitCode).toBe(0);
    expect(result.data!.specs[0]!.violations).toEqual([]);
  });

  it("keeps SPEC-07 for a locally owned materialized node whose RFC is missing", async () => {
    const root = await workspace("    consumers:\n      - werkstatt\n    materializedAs: RFC-9001\n", "werkstatt");
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(root));
    expect(result.exitCode).toBe(1);
    expect(result.data!.specs[0]!.violations.map((v) => v.rule)).toEqual(["SPEC-07"]);
  });

  it("downgrades SPEC-10 node-target overlap to a warning", async () => {
    const root = await workspace("");
    await amendment(root, "AMD-001", "  - kind: node\n    id: EX-001\n");
    await amendment(root, "AMD-002", "  - kind: node\n    id: EX-001\n");
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(root));
    expect(result.exitCode).toBe(0);
    const v = result.data!.specs[0]!.violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "SPEC-10", severity: "warning" });
    expect(v[0]!.message).toContain("AMD-001, AMD-002");
  });

  it("keeps SPEC-10 as an error when two amendments rewrite the same section anchor", async () => {
    const root = await workspace("");
    await fs.writeFile(path.join(root, "docs/specs/example/forge-spec.yaml"),
      (await fs.readFile(path.join(root, "docs/specs/example/forge-spec.yaml"), "utf8"))
        .replace("documents: {}", "documents:\n  doc: doc.md"));
    const t = "  - kind: section\n    document: doc\n    anchor: a\n";
    await amendment(root, "AMD-001", t);
    await amendment(root, "AMD-002", t);
    const result = await runSpecValidate({ argv: [], flags: { spec: "example" } }, ctx(root));
    expect(result.exitCode).toBe(1);
    const spec10 = result.data!.specs[0]!.violations.filter((x) => x.rule === "SPEC-10");
    expect(spec10).toHaveLength(1);
    expect(spec10[0]!.severity).toBeUndefined();
  });
});
