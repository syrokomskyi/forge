/*
<MODULE_CONTRACT>
<purpose>flow.open pending/dirty surface tests (RFC-1533): the result data
carries primaryMutations plus a collectFlowStatus-derived pending summary
excluding the branch just opened; a dirty primary warns FLOW-OPEN-01 without
blocking; an absent or failing registry degrades to pending: null with a
FLOW-OPEN-02 warning — never a refusal.</purpose>
<non-goals>
  <item>No lifecycle coverage beyond open — integrate/discard have their own files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1533: pending summary + dirty-primary warning coverage (AC-1/2/3/5/6)</item>
  <item>RFC-1533: surface pending flow branches in flow.open and the pre-user-prompt nudge</item>
</CHANGE_SUMMARY>
*/

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceIO } from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import { formatFlowBranch } from "../branch-name.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import {
  commonGitDir,
  updateRegistry,
  type FlowRegistryEntry,
} from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

/** Governed repo with a develop branch; returns the primary path. */
async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-open-pending-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await gitExec(dir, ["branch", "develop", "HEAD"]);
  return dir;
}

function registryEntry(
  overrides: Partial<FlowRegistryEntry> & { name: string; baseSha: string },
): FlowRegistryEntry {
  return {
    kind: "session",
    base: "develop",
    worktree: null,
    owner: { kind: "session", id: "unspecified" },
    brief: null,
    openedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    held: null,
    port: null,
    ...overrides,
  };
}

async function developSha(repo: string): Promise<string> {
  const r = await gitExec(repo, ["rev-parse", "develop"]);
  return r.stdout.trim();
}

describe("flow.open pending surface (RFC-1533)", () => {
  it("AC-1/AC-6: dirty primary warns FLOW-OPEN-01, names paths, still opens", async () => {
    const repo = await governedRepo();
    // A tracked mutation: seed.txt was committed by initRepo, now modified.
    await writeFile(join(repo, "seed.txt"), "seed\nmutated\n");

    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "dirty-primary",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    if (data.worktree) dirs.push(data.worktree);

    expect(data.opened).toBe(true);
    const warn = data.diagnostics.find((d) => d.ruleId === "FLOW-OPEN-01");
    expect(warn, "FLOW-OPEN-01 warning missing").toBeDefined();
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toContain("seed.txt");
    expect(data.diagnostics.some((d) => d.severity === "error")).toBe(false);
    expect(data.primaryMutations).toContain("seed.txt");
  }, 15_000);

  it("clean primary reports no warning and empty primaryMutations", async () => {
    const repo = await governedRepo();
    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "clean-primary",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    if (data.worktree) dirs.push(data.worktree);
    expect(data.diagnostics).toEqual([]);
    expect(data.primaryMutations).toEqual([]);
  }, 15_000);

  it("AC-2/AC-3: pending counts registered siblings by kind + stale, excluding self", async () => {
    const repo = await governedRepo();
    const common = await commonGitDir(ambientIo, repo);

    // A stale registered task branch: commit dated >72h back, registry
    // updatedAt just as old.
    const staleName = "auto/task-260730-01-legacy";
    await gitExec(repo, ["switch", "-c", staleName, "develop"]);
    const old = await gitExec(repo, ["commit", "--allow-empty", "-m", "legacy"], {
      GIT_AUTHOR_DATE: "2026-07-30T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-30T00:00:00Z",
    });
    expect(old.exitCode, old.stderr).toBe(0);
    const back = await gitExec(repo, ["switch", "-"]);
    expect(back.exitCode, back.stderr).toBe(0);

    // A fresh registered session branch.
    const freshName = "auto/session-261102-01-fresh";
    await gitExec(repo, ["branch", freshName, "develop"]);

    const baseSha = await developSha(repo);
    await updateRegistry(ambientIo, common, (r) => ({
      ...r,
      branches: [
        ...r.branches,
        registryEntry({
          name: staleName,
          kind: "task",
          baseSha,
          worktree: repo,
          owner: { kind: "task", id: "T-0001" },
          openedAt: "2026-07-30T00:00:00Z",
          updatedAt: "2026-07-30T00:00:00Z",
        }),
        registryEntry({ name: freshName, baseSha, worktree: repo }),
      ],
    }));

    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "pending-check",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    if (data.worktree) dirs.push(data.worktree);

    expect(data.opened).toBe(true);
    expect(data.pending).toEqual({
      total: 2,
      byKind: { session: 1, task: 1, fix: 0 },
      stale: 1,
    });
  }, 20_000);

  it("AC-5: absent registry on a dry-run degrades to pending null + FLOW-OPEN-02", async () => {
    const repo = await governedRepo();
    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "no-registry",
      brief: null,
      owner: null,
      dryRun: true,
      now: NOW,
    });
    expect(data.pending).toBeNull();
    const warn = data.diagnostics.find((d) => d.ruleId === "FLOW-OPEN-02");
    expect(warn?.severity).toBe("warning");
  }, 15_000);

  it("AC-5: collect failure mid-open degrades to pending null + warning, still opens", async () => {
    const repo = await governedRepo();
    const common = await commonGitDir(ambientIo, repo);
    // A registered entry whose worktree path makes io.exists throw inside
    // collectFlowStatus — the summary degrades, the open proceeds.
    const boomName = "auto/session-260930-01-boom";
    await gitExec(repo, ["branch", boomName, "develop"]);
    const baseSha = await developSha(repo);
    await updateRegistry(ambientIo, common, (r) => ({
      ...r,
      branches: [
        ...r.branches,
        registryEntry({
          name: boomName,
          baseSha,
          worktree: join(repo, "BOOM-io-failure"),
          updatedAt: NOW.toISOString(),
        }),
      ],
    }));
    const io: WorkspaceIO = {
      ...ambientIo,
      exists: (path: string) =>
        path.includes("BOOM-io-failure")
          ? Promise.reject(new Error("injected io failure"))
          : ambientIo.exists(path),
    };

    const data = await openFlowBranch(repo, io, {
      kind: "session",
      slug: "pending-fail",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    if (data.worktree) dirs.push(data.worktree);

    expect(data.opened).toBe(true);
    expect(data.pending).toBeNull();
    const warn = data.diagnostics.find((d) => d.ruleId === "FLOW-OPEN-02");
    expect(warn?.severity).toBe("warning");
    expect(data.diagnostics.some((d) => d.severity === "error")).toBe(false);
  }, 20_000);

  it("pending stays empty-shaped on a fresh repo (registered only after open)", async () => {
    const repo = await governedRepo();
    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "first-open",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    if (data.worktree) dirs.push(data.worktree);
    expect(data.pending).toEqual({
      total: 0,
      byKind: { session: 0, task: 0, fix: 0 },
      stale: 0,
    });
  }, 15_000);

  it("the just-opened branch is excluded from pending", async () => {
    const repo = await governedRepo();
    const first = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "first",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    if (first.worktree) dirs.push(first.worktree);
    expect(first.pending?.total).toBe(0);

    const second = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "second",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    if (second.worktree) dirs.push(second.worktree);
    expect(second.branch).toBe(
      formatFlowBranch({ kind: "session", date: NOW, seq: 2, slug: "second" }),
    );
    // The first open is a registered sibling now; the second is excluded.
    expect(second.pending?.total).toBe(1);
    expect(second.pending?.byKind.session).toBe(1);
  }, 20_000);
});
