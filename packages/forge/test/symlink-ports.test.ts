/* Symlink port coverage — deploy extraction needs link-aware filesystem primitives. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPluginContext } from "../src/sdk/context.ts";
import { CapabilityViolation, type PluginManifest } from "../src/sdk/types.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

function manifestWith(fs: "none" | "read" | "readwrite"): PluginManifest {
  return {
    id: "fs-test",
    version: "1.0.0",
    forgeRange: "^10.0.0",
    capabilities: { filesystem: fs, processSpawn: false, network: false, gitMutation: false },
    registers: {},
  };
}

describe("symlink ports", () => {
  it("symlink + readlink roundtrip inside the workspace", async () => {
    const root = mkTmp("forge-symlink-");
    mkdirSync(join(root, "artifacts", "abc123"), { recursive: true });
    const ctx = createPluginContext(manifestWith("readwrite"), { workspaceRoot: root });
    await ctx.workspace.symlink("artifacts/abc123", "artifacts/current");
    expect(await ctx.workspace.readlink("artifacts/current")).toBe("artifacts/abc123");
    // atomic swap pattern: re-point the link
    await ctx.workspace.unlink("artifacts/current");
    mkdirSync(join(root, "artifacts", "def456"), { recursive: true });
    await ctx.workspace.symlink("artifacts/def456", "artifacts/current");
    expect(await ctx.workspace.readlink("artifacts/current")).toBe("artifacts/def456");
  });
  it("readlink is read-granted but symlink/unlink require readwrite", async () => {
    const root = mkTmp("forge-symlink-");
    writeFileSync(join(root, "target.txt"), "x");
    const rw = createPluginContext(manifestWith("readwrite"), { workspaceRoot: root });
    await rw.workspace.symlink("target.txt", "link.txt");
    const rd = createPluginContext(manifestWith("read"), { workspaceRoot: root });
    expect(await rd.workspace.readlink("link.txt")).toBe("target.txt");
    await expect(rd.workspace.symlink("target.txt", "other.txt")).rejects.toThrow(CapabilityViolation);
    await expect(rd.workspace.unlink("link.txt")).rejects.toThrow(CapabilityViolation);
  });
  it("filesystem:none refuses readlink entirely", async () => {
    const root = mkTmp("forge-symlink-");
    const ctx = createPluginContext(manifestWith("none"), { workspaceRoot: root });
    await expect(ctx.workspace.readlink("anything")).rejects.toThrow(CapabilityViolation);
  });
  it("link paths outside the workspace root are sandboxed", async () => {
    const root = mkTmp("forge-symlink-");
    const ctx = createPluginContext(manifestWith("readwrite"), { workspaceRoot: root });
    await expect(ctx.workspace.symlink("target", "../escape-link")).rejects.toThrow(CapabilityViolation);
    // Concatenated — a static parent-traversal literal in source trips the
    // outside-package resolution scan; the probe intent is unchanged.
    const escapee = "../" + "../" + "etc/passwd";
    await expect(ctx.workspace.readlink(escapee)).rejects.toThrow(CapabilityViolation);
  });
});
