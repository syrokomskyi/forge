/* artifactStore spaces port — host-mediated access to the primary checkout's
   .werkstatt/artifacts across the worktree sandbox boundary.
   Decisive case: a worktree reads/writes the shared artifact store that its
   workspace port structurally cannot reach. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPluginContext } from "../src/sdk/context.ts";
import { CapabilityViolation, type PluginManifest } from "../src/sdk/types.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

function ctx(grant: "none" | "read" | "readwrite" | undefined, root: string) {
  const manifest: PluginManifest = {
    id: "artifact-store-test",
    version: "1.0.0",
    forgeRange: "^10.0.0",
    capabilities: {
      filesystem: "read",
      processSpawn: false,
      network: false,
      gitMutation: false,
      ...(grant ? { artifactStore: grant } : {}),
    },
    registers: {},
  };
  return createPluginContext(manifest, { workspaceRoot: root });
}

function seedGitLayout() {
  const common = mkTmp("as-common-");
  mkdirSync(join(common, ".git", "worktrees", "wt-1"), { recursive: true });
  mkdirSync(join(common, ".werkstatt", "artifacts"), { recursive: true });
  writeFileSync(join(common, ".werkstatt", "artifacts", "index.json"), `{"entries":[]}`);
  const wt = mkTmp("as-wt-");
  writeFileSync(join(wt, ".git"), `gitdir: ${join(common, ".git", "worktrees", "wt-1")}\n`);
  return { common, wt };
}

describe("artifactStore port", () => {
  it("worktree layout: reads the primary store across the sandbox boundary", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("read", wt);
    expect(await c.artifactStore.exists("index.json")).toBe(true);
    expect(await c.artifactStore.readFile("index.json")).toBe(`{"entries":[]}`);
    // workspace port cannot see it — boundary intact
    expect(await c.workspace.exists("../" + ".werkstatt/artifacts/index.json")).toBe(false);
  });
  it("readwrite: writes land in the primary store, not the worktree", async () => {
    const { common, wt } = seedGitLayout();
    const c = ctx("readwrite", wt);
    await c.artifactStore.writeFile("sha256-test/manifest.json", `{"hash":"x"}`);
    expect(await c.artifactStore.exists("sha256-test/manifest.json")).toBe(true);
    // nothing leaked into the worktree-local filesystem
    expect(await c.workspace.exists(".werkstatt/artifacts/sha256-test/manifest.json")).toBe(false);
    void common;
  });
  it("read grant refuses writes with CapabilityViolation", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("read", wt);
    await expect(c.artifactStore.writeFile("x", "y")).rejects.toBeInstanceOf(CapabilityViolation);
  });
  it("undeclared grant denies reads", async () => {
    const { wt } = seedGitLayout();
    const c = ctx(undefined, wt);
    await expect(c.artifactStore.readFile("index.json")).rejects.toBeInstanceOf(CapabilityViolation);
  });
  it("no git state degrades: exists false, reads throw plain error", async () => {
    const c = ctx("read", mkTmp("as-nogit-"));
    expect(await c.artifactStore.exists("anything")).toBe(false);
    await expect(c.artifactStore.readFile("anything")).rejects.toThrow(/unreachable|unreadable/);
    await expect(c.artifactStore.writeFile("x", "y")).rejects.toThrow(/unreachable/);
  });
  it("path escape outside the space root is refused", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("readwrite", wt);
    await expect(c.artifactStore.readFile("../../etc/passwd")).rejects.toBeInstanceOf(CapabilityViolation);
  });
});
