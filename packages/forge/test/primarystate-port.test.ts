/* primaryState spaces port — host-mediated access to the primary checkout across
   the worktree sandbox boundary. Decisive case: a worktree reads/writes shared
   primary state (releases/, .werkstatt/) that its workspace port cannot reach. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPluginContext } from "../src/sdk/context.ts";
import { CapabilityViolation, type PluginManifest } from "../src/sdk/types.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

function ctx(grant: "none" | "read" | "readwrite" | undefined, root: string) {
  const manifest: PluginManifest = {
    id: "primary-state-test",
    version: "1.0.0",
    forgeRange: "^10.0.0",
    capabilities: {
      filesystem: "read",
      processSpawn: false,
      network: false,
      gitMutation: false,
      ...(grant ? { primaryState: grant } : {}),
    },
    registers: {},
  };
  return createPluginContext(manifest, { workspaceRoot: root });
}

function seedGitLayout() {
  const common = mkTmp("ps-common-");
  mkdirSync(join(common, ".git", "worktrees", "wt-1"), { recursive: true });
  mkdirSync(join(common, ".werkstatt", "artifacts"), { recursive: true });
  mkdirSync(join(common, "releases", "sys-r1"), { recursive: true });
  writeFileSync(join(common, ".werkstatt", "artifacts", "index.json"), `{"entries":[]}`);
  writeFileSync(join(common, "releases", "sys-r1", "release.yaml"), `systemId: sys\n`);
  const wt = mkTmp("ps-wt-");
  writeFileSync(join(wt, ".git"), `gitdir: ${join(common, ".git", "worktrees", "wt-1")}\n`);
  return { common, wt };
}

describe("primaryState port", () => {
  it("worktree layout: reads primary state across the sandbox boundary", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("read", wt);
    expect(await c.primaryState.exists(".werkstatt/artifacts/index.json")).toBe(true);
    expect(await c.primaryState.readFile("releases/sys-r1/release.yaml")).toBe("systemId: sys\n");
    // workspace port cannot see it — boundary intact
    expect(await c.workspace.exists("releases/sys-r1/release.yaml")).toBe(false);
  });
  it("readwrite: writes land in the primary checkout, not the worktree", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("readwrite", wt);
    await c.primaryState.writeFile("releases/sys-r1/artifact.tar.gz", "bytes");
    expect(await c.primaryState.exists("releases/sys-r1/artifact.tar.gz")).toBe(true);
    expect(await c.workspace.exists("releases/sys-r1/artifact.tar.gz")).toBe(false);
  });
  it("read grant refuses writes with CapabilityViolation", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("read", wt);
    await expect(c.primaryState.writeFile("x", "y")).rejects.toBeInstanceOf(CapabilityViolation);
  });
  it("undeclared grant denies reads", async () => {
    const { wt } = seedGitLayout();
    const c = ctx(undefined, wt);
    await expect(c.primaryState.readFile("releases/sys-r1/release.yaml")).rejects.toBeInstanceOf(
      CapabilityViolation,
    );
  });
  it("no git state degrades: exists false, reads throw plain error", async () => {
    const c = ctx("read", mkTmp("ps-nogit-"));
    expect(await c.primaryState.exists("anything")).toBe(false);
    await expect(c.primaryState.readFile("anything")).rejects.toThrow(/unreachable|unreadable/);
    await expect(c.primaryState.writeFile("x", "y")).rejects.toThrow(/unreachable/);
  });
  it("readdir returns typed entries (engine DirEntry parity)", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("read", wt);
    const entries = await c.primaryState.readdir("releases");
    const sysdir = entries.find((e) => e.name === "sys-r1");
    expect(sysdir).toBeDefined();
    expect(sysdir!.isDirectory).toBe(true);
    expect(sysdir!.isFile).toBe(false);
    const files = await c.primaryState.readdir("releases/sys-r1");
    const yaml = files.find((e) => e.name === "release.yaml");
    expect(yaml!.isFile).toBe(true);
    expect(yaml!.isDirectory).toBe(false);
  });
  it("mkdir materializes empty dirs recursively; read grant refuses", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("readwrite", wt);
    await c.primaryState.mkdir(".werkstatt/locks/nested/deep");
    expect(await c.primaryState.exists(".werkstatt/locks/nested/deep")).toBe(true);
    expect((await c.primaryState.readdir(".werkstatt/locks/nested")).find((e) => e.name === "deep")!.isDirectory).toBe(true);
    const cr = ctx("read", wt);
    await expect(cr.primaryState.mkdir("x")).rejects.toBeInstanceOf(CapabilityViolation);
  });
  it("path escape outside the space root is refused", async () => {
    const { wt } = seedGitLayout();
    const c = ctx("readwrite", wt);
    await expect(c.primaryState.readFile("../../etc/passwd")).rejects.toBeInstanceOf( // pkg-health-10: deliberate escape probe — the test asserts the port refuses it
      CapabilityViolation,
    );
  });
});
