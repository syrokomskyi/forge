/*
<MODULE_CONTRACT>
<purpose>Prove spec.status resolves materializedAs against archived RFCs: an implemented RFC living only under docs/rfcs/archive/implemented/ still marks its node implemented and unblocks the front.</purpose>
<non-goals><item>Do not duplicate spec.validate rule coverage — that lives in spec-validate.test.ts.</item></non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY><item>FIX: initial coverage — archived-implemented dependency unblocks front; top-level draft stays a blocker.</item></CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeRuntimeContext } from "../../src/types.ts";
import { runSpecStatus } from "./spec-status.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "spec-status-"));
  roots.push(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, "docs/rfcs"), { recursive: true });
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
vendoredAt: 2026-10-13
documents: {}
decisions: []
rfcs:
${rfcs}waves:
  - id: 1
    name: Test
    goal: Exercise archived-RFC resolution
`);
}

async function writeRfc(
  workspaceRoot: string,
  relPath: string,
  id: string,
  status: string,
): Promise<void> {
  const filePath = path.join(workspaceRoot, "docs/rfcs", relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `---\nid: ${id}\nstatus: ${status}\n---\n\n# ${id}\n`);
}

function ctx(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    dryRun: false,
    outputFormat: "json",
    logger: { section() {}, info() {}, warn() {}, error() {}, success() {} },
  } as ForgeRuntimeContext;
}

const TWO_NODE_SPEC = `  - id: A
    title: Shipped node
    dependsOn: []
    wave: 1
    sources: []
    materializedAs: RFC-0001
  - id: B
    title: Front node
    dependsOn:
      - A
    wave: 2
    sources: []
`;

describe("spec.status archived-RFC resolution", () => {
  it("resolves an implemented RFC living only under archive/implemented and unblocks the front", async () => {
    const workspaceRoot = await makeWorkspace();
    await writeSpec(workspaceRoot, "journal", TWO_NODE_SPEC);
    await writeRfc(
      workspaceRoot,
      "archive/implemented/rfc-0001-shipped.md",
      "RFC-0001",
      "implemented",
    );

    const result = await runSpecStatus({ argv: [], flags: { spec: "journal" } }, ctx(workspaceRoot));
    expect(result.exitCode).toBe(0);
    const data = result.data as {
      specs: Array<{
        nodes: Array<{ id: string; state: string }>;
        front: string[];
        progress: { implemented: number; total: number };
      }>;
    };
    const spec = data.specs[0]!;
    expect(spec.nodes.find((n) => n.id === "A")!.state).toBe("implemented");
    expect(spec.nodes.find((n) => n.id === "B")!.state).toBe("unmaterialized");
    expect(spec.front).toEqual(["B"]);
    expect(spec.progress).toEqual({ implemented: 1, total: 2 });
  });

  it("keeps a top-level draft RFC as a blocker", async () => {
    const workspaceRoot = await makeWorkspace();
    await writeSpec(workspaceRoot, "journal", TWO_NODE_SPEC);
    await writeRfc(workspaceRoot, "rfc-0001-wip.md", "RFC-0001", "draft");

    const result = await runSpecStatus({ argv: [], flags: { spec: "journal" } }, ctx(workspaceRoot));
    const data = result.data as {
      specs: Array<{
        nodes: Array<{ id: string; state: string; blockedBy: string[] }>;
        front: string[];
      }>;
    };
    const spec = data.specs[0]!;
    expect(spec.nodes.find((n) => n.id === "A")!.state).toBe("draft");
    const b = spec.nodes.find((n) => n.id === "B")!;
    expect(b.state).toBe("unmaterialized");
    expect(b.blockedBy).toEqual(["A"]);
    expect(spec.front).toEqual([]);
  });
});
