/*
<MODULE_CONTRACT>
<purpose>Unit tests for system.products.status (RFC-1639) — member health probing (AC-2), sibling-scan warnings (AC-3), frozen-product semantics (AC-6).</purpose>
<non-goals>
  <item>Not a contract source of truth — the implementation under test owns the behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1639: step 5-6 — acceptance tests, system-hub reference, regenerated manifests</item>
  <item>RFC-1639: review — SYSTEM-MAP-01 rules decl, git-probe warnings, sibling kind/path discriminants, friction.add provenance, ingest hardening</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runSystemProductsStatus } from "../handlers/system-products-status.ts";
import { gitExec, initRepo } from "../../flow/tests/helpers.ts";
import { localMapFor, makeContext, VALID_EDGES_YAML, VALID_SYSTEM_YAML } from "./helpers.ts";

// The sibling scan walks dirname(root), so the hub must sit inside a
// controlled parent — never directly under os.tmpdir() where concurrent
// fixtures would read as unregistered siblings.
let parent: string;
let hub: string;
let alphaDir: string;
let betaDir: string;

const PRODUCTS_YAML = `schema: forge/system-products@1
products:
  - id: alpha
    remote: https://example.invalid/alpha.git
    offers: []
  - id: beta
    remote: https://example.invalid/beta.git
    offers: []
  - id: ghost
    remote: https://example.invalid/ghost.git
    offers: []
    frozen: true
ignored:
  - id: ignored-one
    note: scratch area
`;

const MEMBER_FORGE_YAML = `schema: forge/workspace@1
profile: typescript
forge:
  syncedVersion: "9.7.0"
`;

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "sys-status-parent-"));
  hub = path.join(parent, "warpgogol-verbund");
  alphaDir = path.join(parent, "alpha");
  betaDir = path.join(parent, "beta");
  // alpha — a real git checkout: commit forge.yaml, then dirty a tracked file.
  let seeded = await initRepo({ prefix: "sys-alpha-", branch: "develop" });
  await fs.rename(seeded, alphaDir);
  await fs.writeFile(path.join(alphaDir, "forge.yaml"), MEMBER_FORGE_YAML);
  await gitExec(alphaDir, ["add", "forge.yaml"]);
  await gitExec(alphaDir, ["commit", "-m", "forge.yaml"]);
  await fs.appendFile(path.join(alphaDir, "seed.txt"), "dirty\n");
  // beta — a second real checkout, clean.
  seeded = await initRepo({ prefix: "sys-beta-", branch: "develop" });
  await fs.rename(seeded, betaDir);
  await fs.writeFile(path.join(betaDir, "forge.yaml"), MEMBER_FORGE_YAML);
  await gitExec(betaDir, ["add", "forge.yaml"]);
  await gitExec(betaDir, ["commit", "-m", "forge.yaml"]);

  const hubFiles: Record<string, string> = {
    "forge.yaml": `schema: forge/workspace@1\nprofile: system\nforge:\n  syncedVersion: "9.7.0"\n`,
    "system/system.yaml": VALID_SYSTEM_YAML,
    "system/products.yaml": PRODUCTS_YAML,
    "system/edges.yaml": VALID_EDGES_YAML,
    "system/products.local.yaml": localMapFor({
      alpha: alphaDir,
      beta: betaDir,
      ghost: path.join(parent, "ghost"),
    }),
  };
  for (const [rel, content] of Object.entries(hubFiles)) {
    const abs = path.join(hub, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
});

afterEach(async () => {
  await fs.rm(parent, { recursive: true, force: true });
});

describe("system.products.status — member health (RFC-1639 AC-2)", () => {
  test("reports presence, profile, version parity and git fields per member", async () => {
    const result = await runSystemProductsStatus({ argv: [], flags: {} }, makeContext(hub));
    expect(result.exitCode).toBe(0);
    const data = result.data;
    expect(data?.baseline).toBe("9.7.0");
    const alpha = data?.products.find((p) => p.id === "alpha");
    expect(alpha?.folder).toBe(alphaDir);
    expect(alpha?.profile).toBe("typescript");
    expect(alpha?.forgeVersion).toBe("9.7.0");
    expect(alpha?.versionOk).toBe(true);
    expect(alpha?.dirty).toBe(true); // tracked seed.txt modified post-commit
    const beta = data?.products.find((p) => p.id === "beta");
    expect(beta?.folder).toBe(betaDir);
    expect(beta?.dirty).toBe(false);
    // alpha/beta carry no upstream — aheadOfOrigin degrades to null + warning.
    expect(alpha?.aheadOfOrigin).toBeNull();
  });
});

describe("system.products.status — sibling scan (RFC-1639 AC-3)", () => {
  test("warns on an unregistered forge.yaml sibling and a git sibling without forge.yaml", async () => {
    await fs.mkdir(path.join(parent, "rogue"), { recursive: true });
    await fs.writeFile(path.join(parent, "rogue", "forge.yaml"), MEMBER_FORGE_YAML);
    await fs.mkdir(path.join(parent, "ignored-one"), { recursive: true });
    await fs.writeFile(path.join(parent, "ignored-one", "forge.yaml"), MEMBER_FORGE_YAML);
    await fs.mkdir(path.join(parent, "git-only"), { recursive: true });
    const init = await gitExec(path.join(parent, "git-only"), ["init", "-b", "main"]);
    expect(init.exitCode).toBe(0);

    const result = await runSystemProductsStatus({ argv: [], flags: {} }, makeContext(hub));
    expect(result.exitCode).toBe(0);
    const warned = result.data?.warnings.map((w) => w.message).join("\n") ?? "";
    expect(warned).toContain("rogue");
    expect(warned).toContain("git-only");
    expect(warned).not.toContain("ignored-one");
  });
});

describe("system.products.status — frozen members (RFC-1639 AC-6)", () => {
  test("a missing frozen member reports null probes with a warning, never an error", async () => {
    const result = await runSystemProductsStatus({ argv: [], flags: {} }, makeContext(hub));
    expect(result.exitCode).toBe(0);
    const ghost = result.data?.products.find((p) => p.id === "ghost");
    expect(ghost?.frozen).toBe(true);
    expect(ghost?.versionOk).toBeNull();
    expect(result.data?.errors ?? []).toHaveLength(0);
    const warned = result.data?.warnings.map((w) => w.message).join("\n") ?? "";
    expect(warned).toContain("ghost");
  });

  test("a missing non-frozen member is an error and fails the command", async () => {
    const products = PRODUCTS_YAML.replace("    frozen: true\n", "");
    await fs.writeFile(path.join(hub, "system", "products.yaml"), products);
    const result = await runSystemProductsStatus({ argv: [], flags: {} }, makeContext(hub));
    expect(result.exitCode).toBe(1);
    const errors = result.data?.errors.map((e) => e.message).join("\n") ?? "";
    expect(errors).toContain("ghost");
  });
});
