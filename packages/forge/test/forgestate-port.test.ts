/* forgeState port — host-implemented reads of .git/forge/ across the sandbox boundary.
   Critical case: worktree pointer-file resolution to the common git dir. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPluginContext, resolveGitCommonDir } from "../src/sdk/context.ts";
import { CapabilityViolation, type PluginManifest } from "../src/sdk/types.ts";
import { mkTmp } from "./helpers/queue-fixture.ts";

function ctx(forgeState: "none" | "read" | undefined, root: string) {
  const manifest: PluginManifest = {
    id: "fs-state-test",
    version: "1.0.0",
    forgeRange: "^10.0.0",
    capabilities: {
      filesystem: "read",
      processSpawn: false,
      network: false,
      gitMutation: false,
      ...(forgeState ? { forgeState } : {}),
    },
    registers: {},
  };
  return createPluginContext(manifest, { workspaceRoot: root });
}

function seedJournal(commonGitDir: string, events: string[]): void {
  mkdirSync(join(commonGitDir, "forge"), { recursive: true });
  writeFileSync(
    join(commonGitDir, "forge", "journal.jsonl"),
    events.map((e) => JSON.stringify({ at: "2026-11-25T00:00:00Z", event: e })).join("\n") + "\n",
  );
}

describe("resolveGitCommonDir", () => {
  it("primary checkout: .git as directory resolves to itself", async () => {
    const root = mkTmp("forge-gitdir-");
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(await resolveGitCommonDir(root)).toBe(join(root, ".git"));
  });
  it("worktree: pointer file resolves to the common dir", async () => {
    const root = mkTmp("forge-gitdir-");
    const common = mkTmp("forge-common-");
    mkdirSync(join(common, ".git", "worktrees", "wt-1"), { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${join(common, ".git", "worktrees", "wt-1")}\n`);
    expect(await resolveGitCommonDir(root)).toBe(join(common, ".git"));
  });
  it("no git state returns null", async () => {
    expect(await resolveGitCommonDir(mkTmp("forge-gitdir-"))).toBeNull();
  });
});

describe("forgeState.journal", () => {
  it("primary layout: tail reads last N records oldest-first", async () => {
    const root = mkTmp("forge-journal-");
    mkdirSync(join(root, ".git"), { recursive: true });
    seedJournal(join(root, ".git"), ["open", "commit", "integrate"]);
    const c = ctx("read", root);
    const tail = await c.forgeState.journal.tail(2);
    expect(tail.map((r) => r.event)).toEqual(["commit", "integrate"]);
    expect(await c.forgeState.journal.size()).toBe(3);
  });
  it("worktree layout: journal reads across the sandbox boundary", async () => {
    // The decisive case — the journal file lives OUTSIDE the worktree root,
    // unreachable through ctx.workspace, reachable through the host port.
    const common = mkTmp("forge-common-");
    mkdirSync(join(common, ".git", "worktrees", "wt-1"), { recursive: true });
    seedJournal(join(common, ".git"), ["open", "close"]);
    const wt = mkTmp("forge-wt-");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(common, ".git", "worktrees", "wt-1")}\n`);
    const c = ctx("read", wt);
    expect((await c.forgeState.journal.tail(5)).map((r) => r.event)).toEqual(["open", "close"]);
    // workspace port cannot see it — boundary intact
    expect(await c.workspace.exists(".git/forge/journal.jsonl")).toBe(false);
  });
  it("no journal anywhere degrades to empty", async () => {
    const c = ctx("read", mkTmp("forge-journal-"));
    expect(await c.forgeState.journal.tail(5)).toEqual([]);
    expect(await c.forgeState.journal.size()).toBe(0);
  });
  it("forgeState:none refuses with CapabilityViolation", async () => {
    const c = ctx(undefined, mkTmp("forge-journal-"));
    await expect(c.forgeState.journal.tail(1)).rejects.toThrow(CapabilityViolation);
    await expect(c.forgeState.journal.size()).rejects.toThrow(CapabilityViolation);
  });
  it("torn lines tolerate without dropping the record", async () => {
    const root = mkTmp("forge-journal-");
    mkdirSync(join(root, ".git", "forge"), { recursive: true });
    writeFileSync(join(root, ".git", "forge", "journal.jsonl"), '{"event":"good"}\nnot-json\n');
    const tail = await ctx("read", root).forgeState.journal.tail(5);
    expect(tail).toHaveLength(2);
    expect(tail[1].event).toBe("torn-line");
  });
});
