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
