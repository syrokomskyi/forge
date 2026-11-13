/*
<MODULE_CONTRACT>
<purpose>Test helpers for forge system-module suites (RFC-1508) — makeSystemRepo
materializes a temporary system-profile repository under os.tmpdir();
makeContext builds a ForgeRuntimeContext for direct handler invocation;
canonical YAML fixture strings keep tests focused on the variable under test.</purpose>
<non-goals>
  <item>Fixtures only — no test assertions here.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1508: step 1 — shared system test helpers (RFC-1509..1511 reuse)</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
  <item>RFC-1508: align rfc-1508 schemas with the normative contract after review r1</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ForgeRuntimeContext } from "../../../src/types.ts";

/**
 * Write a temporary repository: `forge.yaml` declares `profile: system`
 * (overridable via files["forge.yaml"]) plus every entry in `files` at its
 * repo-relative path. Returns the repo root.
 */
export async function makeSystemRepo(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-system-"));
  const all = { "forge.yaml": "profile: system\n", ...files };
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

export function makeContext(root: string): ForgeRuntimeContext {
  const sink = (_msg: string, _details?: unknown): void => {};
  return {
    workspaceRoot: root,
    logger: { section: sink, info: sink, warn: sink, error: sink, success: sink },
    dryRun: false,
    outputFormat: "json",
  };
}

// ---------------------------------------------------------------------------
// Canonical fixtures
// ---------------------------------------------------------------------------

export const VALID_SYSTEM_YAML = `schema: forge/system@1
id: demo-system
name: Demo System
owners:
  - ops
`;

export const VALID_PRODUCTS_YAML = `schema: forge/system-products@1
products:
  - id: alpha
    remote: https://example.invalid/alpha.git
    offers:
      - alpha-contract
  - id: beta
    remote: https://example.invalid/beta.git
    offers: []
`;

export const VALID_EDGES_YAML = `schema: forge/system-edges@1
allowed:
  - consumer: beta
    contract: alpha-contract
forbidden: []
`;

/**
 * A fully valid repository: all three map files plus a products.local.yaml
 * mapping both products to existing folders (created via .gitkeep entries).
 */
export function validMapFiles(): Record<string, string> {
  return {
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": VALID_PRODUCTS_YAML,
    "system/edges.yaml": VALID_EDGES_YAML,
    "system/products.local.yaml": `schema: forge/system-products-local@1
folders:
  alpha: ./alpha
  beta: ./beta
launcher:
  argv: [echo, "{worktree}", "{task}"]
`,
    "alpha/.gitkeep": "",
    "beta/.gitkeep": "",
  };
}

// ---------------------------------------------------------------------------
// RFC-1509 product fixtures — governed product repos under os.tmpdir()
// ---------------------------------------------------------------------------

/**
 * Materialize a governed product repository: `git init` on main, a forge.yaml
 * seed commit and a `develop` branch — the minimum openFlowBranchCore asks
 * for. Lives OUTSIDE the system repo so dispatch resolves a real checkout.
 * Returns the absolute product root.
 */
export async function makeProduct(prefix = "forge-product-"): Promise<string> {
  const { gitExec, installFakePrimaryForge } = await import("../../flow/tests/helpers.ts");
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const init = await gitExec(root, ["init", "-b", "main"]);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
  // RFC-1580: flow.integrate spawns the primary install's correctness.gate.
  await installFakePrimaryForge(root);
  await gitExec(root, ["config", "user.email", "system-test@example.invalid"]);
  await gitExec(root, ["config", "user.name", "system-test"]);
  await gitExec(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(root, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await gitExec(root, ["add", "-A"]);
  const seed = await gitExec(root, ["commit", "-m", "seed"]);
  if (seed.exitCode !== 0) throw new Error(`seed commit failed: ${seed.stderr}`);
  const develop = await gitExec(root, ["branch", "develop"]);
  if (develop.exitCode !== 0) throw new Error(`develop branch failed: ${develop.stderr}`);
  // flow.integrate requires the primary checkout to sit on develop.
  const checkout = await gitExec(root, ["checkout", "develop"]);
  if (checkout.exitCode !== 0) throw new Error(`develop checkout failed: ${checkout.stderr}`);
  return root;
}

/** products.local.yaml entry pointing at an absolute product checkout. */
export function localMapFor(entries: Record<string, string>, launcherArgv?: string[]): string {
  const folders = Object.entries(entries)
    .map(([id, folder]) => `  ${id}: ${JSON.stringify(folder)}`)
    .join("\n");
  const launcher = launcherArgv
    ? `launcher:\n  argv: [${launcherArgv.map((a) => JSON.stringify(a)).join(", ")}]\n`
    : "";
  return `schema: forge/system-products-local@1\nfolders:\n${folders}\n${launcher}`;
}

/** A minimal forge/system-task@1 file content for fixture seeding. */
export function taskYaml(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    schema: "forge/system-task@1",
    id: "T-0001",
    title: "fixture task",
    product: "alpha",
    slug: "fixture-task",
    kind: "change",
    state: "proposed",
    origin: { kind: "operator", ref: null },
    contracts: [],
    dependsOn: [],
    brief: "queue/briefs/T-0001.md",
    briefSha256: null,
    dispatch: null,
    report: null,
    integratedCommit: null,
    history: [{ at: "2026-01-01T00:00:00Z", from: "none", to: "proposed", by: "operator" }],
    ...overrides,
  };
  const yaml = Object.entries(base)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return `${yaml}\n`;
}

/** A ready-state dispatch brief with a real goal. */
export function readyBrief(taskId = "T-0001", product = "alpha"): string {
  return `---
schema: forge/dispatch-brief@1
task: ${taskId}
product: ${product}
goal: "prove the dispatch pipeline end to end"
acceptance:
  - claim: "the branch exists"
    check: "git branch --list auto/task-*"
constraints: []
---

# ${taskId}

prove the dispatch pipeline end to end
`;
}
