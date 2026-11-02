/*
<MODULE_CONTRACT>
<purpose>flow.backmerge tests (RFC-1490): a release ahead on main ports
into develop through a gated auto/session port branch — clean merge fast-
forwards the primary and tears the port down (AC-9), a conflicting merge
stays in progress with conflicted paths and recovery steps, --redo discards
a stale port for the same mainSha, and FLOW-BM-01/02 refusals hold.</purpose>
<non-goals>
  <item>No fix releases — flow.fix tests cover that path.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>main-ahead state is built by a detached worktree commit under FORGE_FLOW_OP=install (the guard's adoption vocabulary) — the only way to commit onto a protected line in a fixture.</item>
  <item>The develop-side change for a conflict lands through a real session branch + integrate — the same path production uses.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 5 — backmerge clean/conflict/redo/not-needed tests</item>
  <item>RFC-1490: step 5 — flow.backmerge (port branch, fixed merge message, conflict + --redo paths)</item>
  <item>RFC-1490: independent-review pass — lock-held planning, fix-branch verification, spec-shaped data, coverage</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { readRegistry, commonGitDir } from "../registry.ts";
import { gitExec, initRepo, installGuard } from "./helpers.ts";
import { backmergeFlow } from "../handlers/flow-backmerge.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch, openFlowBranchCore } from "../handlers/flow-open.ts";
import { runOrdinaryCut } from "../handlers/flow-cut.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function sha(repo: string, ref: string): Promise<string> {
  return (await gitExec(repo, ["rev-parse", ref])).stdout.trim();
}

/** Adopted repo → one cut → main carries release v0.1.2 past develop. */
async function repoWithPendingRelease(opts?: { conflicting?: boolean }): Promise<string> {
  const repo = await initRepo({ prefix: "flow-bm-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(
    join(repo, "package.json"),
    '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
  );
  await writeFile(join(repo, "fix.txt"), "A\n");
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "config"]);
  await gitExec(repo, ["switch", "-c", "develop"]);
  await installGuard(repo);
  await gitExec(repo, ["add", "hooks"]);
  await gitExec(repo, ["commit", "-m", "adopt"], { FORGE_FLOW_OP: "install" });
  await gitExec(repo, ["tag", "-a", "v0.1.0", "main", "-m", "release v0.1.0"]);

  const cut = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
  expect(cut.diagnostics).toEqual([]);
  expect(cut.released).toBe(true); // v0.1.1 — main now equals develop

  if (opts?.conflicting) {
    // A session-side change to fix.txt lands on develop after the cut.
    const s = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "devwork",
      brief: null,
      owner: null,
      dryRun: false,
    });
    expect(s.diagnostics).toEqual([]);
    dirs.push(s.worktree!);
    await writeFile(join(s.worktree!, "fix.txt"), "D\n");
    await gitExec(s.worktree!, ["add", "fix.txt"]);
    await gitExec(s.worktree!, ["commit", "-m", "develop-side fix"]);
    const int = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
    });
    expect(int.diagnostics).toEqual([]);
  }

  // main-side fix: detached worktree commit + release tag + main update.
  const tmp = await mkdtemp(join(tmpdir(), "flow-bm-main-"));
  dirs.push(tmp);
  await gitExec(repo, ["worktree", "add", "--detach", tmp, "main"]);
  await writeFile(join(tmp, "fix.txt"), "C\n");
  await gitExec(tmp, ["add", "fix.txt"]);
  const fix = await gitExec(tmp, ["commit", "-m", "hotfix"], { FORGE_FLOW_OP: "install" });
  expect(fix.exitCode).toBe(0);
  const fixSha = await sha(tmp, "HEAD");
  await gitExec(repo, ["tag", "-a", "v0.1.2", fixSha, "-m", "release v0.1.2"]);
  await gitExec(repo, ["update-ref", "refs/heads/main", fixSha]);
  await gitExec(repo, ["worktree", "remove", "--force", tmp]);
  return repo;
}

describe("flow.backmerge", () => {
  it("reports not-needed when main is already an ancestor of develop", async () => {
    const repo = await initRepo({ prefix: "flow-bm-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "config"]);
    await gitExec(repo, ["switch", "-c", "develop"]);

    const data = await backmergeFlow(repo, ambientIo, { redo: false, dryRun: false });
    expect(data.status).toBe("not-needed");
    expect(data.diagnostics).toEqual([]);
  });

  it("clean merge ports main into develop and tears the port down (AC-9)", async () => {
    const repo = await repoWithPendingRelease();
    const data = await backmergeFlow(repo, ambientIo, { redo: false, dryRun: false });

    expect(data.diagnostics).toEqual([]);
    expect(data.status).toBe("merged");
    expect(data.tags).toEqual(["v0.1.2"]);
    // develop carries a merge commit whose second parent is main's tip.
    const mainSha = await sha(repo, "main");
    const tip = await gitExec(repo, ["rev-list", "--parents", "-1", "develop"]);
    const parts = tip.stdout.trim().split(/\s+/);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe(mainSha);
    const subject = (await gitExec(repo, ["log", "-1", "--format=%s", "develop"])).stdout.trim();
    expect(subject).toBe("release v0.1.2 → develop");
    // Port branch + registry entry are gone.
    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    expect(registry.branches.filter((b) => b.port !== null)).toEqual([]);
    expect(
      (await gitExec(repo, ["branch", "--list", "auto/session-*-port-v0-1-2"])).stdout.trim(),
    ).toBe("");
    // main is now an ancestor of develop — a rerun is a no-op.
    const again = await backmergeFlow(repo, ambientIo, { redo: false, dryRun: false });
    expect(again.status).toBe("not-needed");
  }, 30_000);

  it("conflict leaves the merge in progress with paths and nextSteps; integrate completes it", async () => {
    const repo = await repoWithPendingRelease({ conflicting: true });
    const data = await backmergeFlow(repo, ambientIo, { redo: false, dryRun: false });

    expect(data.status).toBe("conflict");
    expect(data.conflicts).toEqual(["fix.txt"]);
    expect(data.portWorktree).not.toBeNull();
    dirs.push(data.portWorktree!);
    // Merge still in progress.
    const mergeHead = await gitExec(data.portWorktree!, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    expect(mergeHead.exitCode).toBe(0);

    // Operator resolves + commits --no-edit, then integrates the port.
    await writeFile(join(data.portWorktree!, "fix.txt"), "resolved\n");
    await gitExec(data.portWorktree!, ["add", "fix.txt"]);
    const committed = await gitExec(data.portWorktree!, ["commit", "--no-edit"], {
      FORGE_FLOW_OP: "",
    });
    expect(committed.exitCode).toBe(0);

    const int = await integrateFlowBranch(repo, ambientIo, {
      branch: data.portBranch!,
      dryRun: false,
    });
    expect(int.diagnostics).toEqual([]);
    expect(int.integrated).toBe(true);
    const subject = (await gitExec(repo, ["log", "-1", "--format=%s", "develop"])).stdout.trim();
    expect(subject).toBe("release v0.1.2 → develop");
  }, 40_000);

  it("refuses FLOW-BM-02 on a duplicate port for the same mainSha; --redo reopens", async () => {
    const repo = await repoWithPendingRelease({ conflicting: true });
    const first = await backmergeFlow(repo, ambientIo, { redo: false, dryRun: false });
    expect(first.status).toBe("conflict");
    dirs.push(first.portWorktree!);

    const dup = await backmergeFlow(repo, ambientIo, { redo: false, dryRun: false });
    expect(dup.status).toBe("refused");
    expect(dup.diagnostics[0]?.ruleId).toBe("FLOW-BM-02");

    const redo = await backmergeFlow(repo, ambientIo, { redo: true, dryRun: false });
    // Same state → the reopened port conflicts again; the stale port was
    // discarded so the registry carries exactly one entry for mainSha.
    expect(redo.status).toBe("conflict");
    dirs.push(redo.portWorktree!);
    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    expect(registry.branches.filter((b) => b.port !== null)).toHaveLength(1);
  }, 40_000);

  it("refuses FLOW-BM-01 on a dirty primary", async () => {
    const repo = await repoWithPendingRelease();
    await writeFile(join(repo, "dirty.txt"), "x");
    await gitExec(repo, ["add", "dirty.txt"]);
    const data = await backmergeFlow(repo, ambientIo, { redo: false, dryRun: false });
    expect(data.status).toBe("refused");
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-BM-01");
  }, 30_000);

  it("flow.integrate refuses a port whose tip is not the fixed merge (FLOW-INT-09)", async () => {
    const repo = await repoWithPendingRelease();
    const mainSha = await sha(repo, "main");
    const open = await openFlowBranchCore(repo, ambientIo, {
      kind: "session",
      slug: "port-v0-1-2",
      brief: "handmade port",
      owner: { kind: "session", id: "backmerge" },
      port: { mainSha, tags: ["v0.1.2"] },
      dryRun: false,
    });
    expect(open.opened).toBe(true);
    dirs.push(open.worktree!);
    // A plain commit on the port — never the fixed-format merge.
    await writeFile(join(open.worktree!, "sneak.txt"), "x\n");
    await gitExec(open.worktree!, ["add", "sneak.txt"]);
    await gitExec(open.worktree!, ["commit", "-m", "not a port merge"], { FORGE_FLOW_OP: "" });

    const int = await integrateFlowBranch(repo, ambientIo, {
      branch: open.branch!,
      dryRun: false,
    });
    expect(int.integrated).toBe(false);
    expect(int.diagnostics[0]?.ruleId).toBe("FLOW-INT-09");
  }, 30_000);

  it("flow.integrate refuses a port when develop moved since it opened (FLOW-INT-10)", async () => {
    const repo = await repoWithPendingRelease();
    const mainSha = await sha(repo, "main");
    const open = await openFlowBranchCore(repo, ambientIo, {
      kind: "session",
      slug: "port-v0-1-2",
      brief: "handmade port",
      owner: { kind: "session", id: "backmerge" },
      port: { mainSha, tags: ["v0.1.2"] },
      dryRun: false,
    });
    expect(open.opened).toBe(true);
    dirs.push(open.worktree!);
    // The real fixed-format merge lands on the port…
    const merge = await gitExec(
      open.worktree!,
      ["merge", "--no-ff", "-m", "release v0.1.2 → develop", "main"],
      { FORGE_FLOW_OP: "" },
    );
    expect(merge.exitCode).toBe(0);
    // …but develop moves before the port integrates (plumbing commit).
    const tree = (await gitExec(repo, ["rev-parse", "develop^{tree}"])).stdout.trim();
    const moved = (
      await gitExec(repo, ["commit-tree", tree, "-p", "develop", "-m", "develop moved"])
    ).stdout.trim();
    await gitExec(repo, ["update-ref", "refs/heads/develop", moved]);

    const int = await integrateFlowBranch(repo, ambientIo, {
      branch: open.branch!,
      dryRun: false,
    });
    expect(int.integrated).toBe(false);
    expect(int.diagnostics[0]?.ruleId).toBe("FLOW-INT-10");
  }, 30_000);
});
