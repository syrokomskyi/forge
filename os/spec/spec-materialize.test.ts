/*
<MODULE_CONTRACT>
<purpose>Prove consumer-aware dependsOn filtering in spec.materialize (RFC-1240): foreign-owned nodes are excluded from the front and satisfy dependents; same-consumer and undeclared-identity nodes keep local gating.</purpose>
<non-goals><item>Do not duplicate spec.validate rule coverage — that lives in spec-validate.test.ts.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY><item>RFC-1240: initial coverage — foreign dep satisfaction, same-consumer gating, identity-missing skip, --consumer flag precedence, legacy snapshot compatibility.</item></CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeRuntimeContext } from "../../src/types.ts";
import { runSpecMaterialize } from "./spec-materialize.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(opts: { consumer?: string } = {}): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-materialize-"));
  roots.push(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, "docs/rfcs"), { recursive: true });
  if (opts.consumer !== undefined) {
    await fs.writeFile(
      path.join(workspaceRoot, "forge.yaml"),
      `schema: forge/config@1\nproject:\n  name: test-ws\n  consumer: ${opts.consumer}\npaths: {}\n`,
    );
  }
  return workspaceRoot;
}

async function writeSpec(workspaceRoot: string, id: string, rfcs: string): Promise<void> {
  const specDir = path.join(workspaceRoot, "docs/specs", id);
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(path.join(specDir, "forge-spec.yaml"), `schema: forge/spec@1
id: ${id}
title: ${id}
version: 1.0.0
status: accepted
reviewers: []
sourceNote: test fixture
vendoredAt: 2026-10-09
documents: {}
decisions: []
rfcs:
${rfcs}waves:
  - id: 1
    name: Test
    goal: Exercise consumer filtering
`);
}

const MULTI_SPEC = `  - id: V02
    title: Consumer scoped node
    dependsOn: []
    wave: 1
    sources: []
    consumers:
      - personal-agent
  - id: V04
    title: Dependent node
    dependsOn:
      - V02
    wave: 1
    sources: []
  - id: V05
    title: Pinned node
    dependsOn: []
    wave: 1
    sources: []
    materializedAs: RFC-9001
`;

function ctx(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    dryRun: false,
    outputFormat: "json",
    logger: { section() {}, info() {}, warn() {}, error() {}, success() {} },
  } as ForgeRuntimeContext;
}

describe("spec.materialize consumer filtering (RFC-1240)", () => {
  it("treats a foreign-consumer dependency as satisfied and excludes the foreign node from the front", async () => {
    const workspaceRoot = await makeWorkspace({ consumer: "werkstatt" });
    await writeSpec(workspaceRoot, "multi", MULTI_SPEC);
    const result = await runSpecMaterialize({ argv: [], flags: { spec: "multi" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(0);
    const data = result.data as {
      created: Array<{ node: string; rfc: string }>;
      front: string[];
      foreignOwned: string[];
    };
    expect(data.created).toHaveLength(1);
    expect(data.created[0]!.node).toBe("V04");
    expect(data.created[0]!.rfc).toBe("RFC-0001");
    expect(data.foreignOwned).toEqual(["V02"]);
    expect(data.front).toEqual([]);
    // AC-5: pre-existing materializedAs pins survive the write-back untouched.
    const rewritten = await fs.readFile(
      path.join(workspaceRoot, "docs/specs/multi/forge-spec.yaml"), "utf8");
    expect(rewritten).toContain("materializedAs: RFC-9001");
    expect(rewritten).toContain("materializedAs: RFC-0001");
  });

  it("keeps same-consumer dependencies blocking until implemented", async () => {
    const workspaceRoot = await makeWorkspace({ consumer: "werkstatt" });
    await writeSpec(workspaceRoot, "same", `  - id: V02
    title: Locally owned node
    dependsOn: []
    wave: 1
    sources: []
    consumers:
      - werkstatt
  - id: V04
    title: Dependent node
    dependsOn:
      - V02
    wave: 1
    sources: []
`);
    const result = await runSpecMaterialize({ argv: [], flags: { spec: "same", nodes: "V04" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(1);
    const data = result.data as { skipped: Array<{ node: string; reason: string }> };
    expect(data.skipped).toEqual([{ node: "V04", reason: "blocked by V02" }]);
  });

  it("reports 'consumer identity not configured' when consumers are declared without a local identity", async () => {
    const workspaceRoot = await makeWorkspace();
    await writeSpec(workspaceRoot, "noidentity", MULTI_SPEC);
    const result = await runSpecMaterialize({ argv: [], flags: { spec: "noidentity", nodes: "V02" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(1);
    const data = result.data as {
      skipped: Array<{ node: string; reason: string }>;
      foreignOwned: string[];
    };
    expect(data.skipped).toEqual([{ node: "V02", reason: "consumer identity not configured" }]);
    expect(data.foreignOwned).toEqual(["V02"]);
  });

  it("lets --consumer override forge.yaml and claims the node as locally owned", async () => {
    const workspaceRoot = await makeWorkspace({ consumer: "werkstatt" });
    await writeSpec(workspaceRoot, "flagwin", MULTI_SPEC);
    const result = await runSpecMaterialize(
      { argv: [], flags: { spec: "flagwin", consumer: "personal-agent" } },
      ctx(workspaceRoot),
    );
    expect(result.exitCode).toBe(0);
    const data = result.data as {
      created: Array<{ node: string }>;
      foreignOwned: string[];
    };
    expect(data.created.map((c) => c.node)).toEqual(["V02"]);
    expect(data.foreignOwned).toEqual([]);
  });

  it("reports 'foreign-owned by <consumers>' when the local identity is set but not a member", async () => {
    const workspaceRoot = await makeWorkspace({ consumer: "werkstatt" });
    await writeSpec(workspaceRoot, "foreign", MULTI_SPEC);
    const result = await runSpecMaterialize({ argv: [], flags: { spec: "foreign", nodes: "V02" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(1);
    const data = result.data as { skipped: Array<{ node: string; reason: string }> };
    expect(data.skipped).toEqual([{ node: "V02", reason: "foreign-owned by personal-agent" }]);
  });

  it("keeps consumer-free snapshots fully backward compatible", async () => {
    const workspaceRoot = await makeWorkspace();
    await writeSpec(workspaceRoot, "legacy", `  - id: V01
    title: Plain node
    dependsOn: []
    wave: 1
    sources: []
  - id: V02
    title: Dependent plain node
    dependsOn:
      - V01
    wave: 1
    sources: []
`);
    const result = await runSpecMaterialize({ argv: [], flags: { spec: "legacy" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(0);
    const data = result.data as {
      created: Array<{ node: string }>;
      foreignOwned: string[];
    };
    expect(data.created.map((c) => c.node)).toEqual(["V01"]);
    expect(data.foreignOwned).toEqual([]);
  });
});
