/*
<MODULE_CONTRACT>
<purpose>flow.discard tests (RFC-1487 step 5, AC-6): a clean registered
branch loses its worktree dir, branch ref and registry entry; a dirty
worktree without --dirty refuses FLOW-DIS-03; a teardown refusal is
FLOW-DIS-02; --dirty forces removal.</purpose>
<non-goals>
  <item>No integrate/status coverage — separate files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 5 — flow.discard tests</item>
  <item>RFC-1487: step 5 — flow.discard, flow.status, flow.check FLOW-06/07</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { discardFlowBranch } from "../handlers/flow-discard.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { commonGitDir, readRegistry } from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-dis-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await gitExec(dir, ["branch", "develop", "HEAD"]);
  await gitExec(dir, ["switch", "develop"]);
  return dir;
}

async function openSession(repo: string, slug: string) {
  const data = await openFlowBranch(repo, ambientIo, {
    kind: "session",
    slug,
    brief: null,
    owner: null,
    dryRun: false,
    now: NOW,
  });
  expect(data.diagnostics).toEqual([]);
  dirs.push(data.worktree!);
  return data;
}

describe("flow.discard", () => {
  it("removes worktree, branch and registry entry on a clean branch (AC-6)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "drop-me");
    await writeFile(join(session.worktree!, "d.txt"), "d");
    await gitExec(session.worktree!, ["add", "d.txt"]);
    await gitExec(session.worktree!, ["commit", "-m", "add d.txt"]);

    const data = await discardFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      reason: "superseded",
      dirty: false,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.discarded).toBe(true);
    expect(await ambientIo.exists(session.worktree!)).toBe(false);
    expect((await gitExec(repo, ["rev-parse", "--verify", `refs/heads/${session.branch}`])).exitCode).not.toBe(0);
    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    expect(registry.branches.some((b) => b.name === session.branch)).toBe(false);
  }, 20_000);

  it("refuses FLOW-DIS-03 on a dirty worktree without --dirty", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "dirty-drop");
    await writeFile(join(session.worktree!, "seed.txt"), "modified\n");

    const data = await discardFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      reason: "test",
      dirty: false,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-DIS-03");
    expect(await ambientIo.exists(session.worktree!)).toBe(true);
  }, 20_000);

  it("--dirty force-removes a worktree with uncommitted changes", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "force-drop");
    await writeFile(join(session.worktree!, "seed.txt"), "modified\n");

    const data = await discardFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      reason: "abandoned",
      dirty: true,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.discarded).toBe(true);
    expect(await ambientIo.exists(session.worktree!)).toBe(false);
  }, 20_000);

  it("refuses FLOW-DIS-02 when the teardown script refuses", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "teardown");
    await mkdir(join(repo, "hooks"), { recursive: true });
    await writeFile(join(repo, "hooks", "worktree-teardown.sh"), "#!/bin/sh\necho no >&2\nexit 1\n");

    const data = await discardFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      reason: "test",
      dirty: false,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-DIS-02");
    expect(await ambientIo.exists(session.worktree!)).toBe(true);
    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    expect(registry.branches.some((b) => b.name === session.branch)).toBe(true);
  }, 20_000);
});
