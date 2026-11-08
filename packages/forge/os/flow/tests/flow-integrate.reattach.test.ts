/*
<MODULE_CONTRACT>
<purpose>flow.integrate --reattach tests (RFC-1531 AC-1/AC-2/AC-7): a
registered branch whose worktree vanished integrates after one --reattach
run — the worktree is recreated at the recorded registry path (or the
canonical sibling when its parent is gone) inside the integration lock; a
no-flag run still refuses and its fixHint names --reattach; --dry-run
reports the target without mutating; an occupied recorded path refuses
FLOW-INT-17.</purpose>
<non-goals>
  <item>No dirty-tree remediation — flow-integrate.remediation.test.ts owns --auto-clean/--autocommit.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1531: closed dirty-path classifier + remediation flags on flow.integrate</item>
  <item>RFC-1531: add flow.integrate remediation flags on the shared dirty classifier</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import {
  commonGitDir,
  readRegistry,
  updateRegistry,
} from "../registry.ts";
import { flowWorktreePath } from "../worktree-path.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-reattach-" });
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

async function commitIn(worktree: string, file: string, content: string): Promise<void> {
  await writeFile(join(worktree, file), content);
  await gitExec(worktree, ["add", file]);
  const r = await gitExec(worktree, ["commit", "-m", `add ${file}`]);
  if (r.exitCode !== 0) throw new Error(`commit in ${worktree} failed: ${r.stderr}`);
}

describe("flow.integrate --reattach (RFC-1531)", () => {
  it("AC-1: recreates the vanished worktree at the recorded registry path and integrates", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "vanished");
    await commitIn(session.worktree!, "rescue.txt", "rescued work");
    const recorded = session.worktree!;
    await rm(recorded, { recursive: true, force: true });

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      reattach: true,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.reattachedTo).toBe(recorded);
    expect(data.integrated).toBe(true);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:rescue.txt"])).exitCode).toBe(0);
    // Cleanup tore the reattached worktree down with the rest of the flow.
    expect(await ambientIo.exists(recorded)).toBe(false);
    expect(data.cleanedUp).toBe(true);
  }, 20_000);

  it("AC-1b: falls back to the canonical sibling path when the recorded parent is gone", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "relocated");
    await commitIn(session.worktree!, "r.txt", "work");
    await rm(session.worktree!, { recursive: true, force: true });
    // Rewrite the recorded path to one whose parent does not exist — the
    // canonical <repo>@<branch> sibling takes over.
    const common = await commonGitDir(ambientIo, repo);
    const phantom = join(dirname(repo), "no-such-parent-xyz", "wt");
    await updateRegistry(ambientIo, common, (r) => ({
      ...r,
      branches: r.branches.map((b) =>
        b.name === session.branch ? { ...b, worktree: phantom } : b,
      ),
    }));

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      reattach: true,
    });

    const canonical = flowWorktreePath(repo, session.branch!);
    expect(data.diagnostics).toEqual([]);
    expect(data.reattachedTo).toBe(canonical);
    expect(data.integrated).toBe(true);
    dirs.push(canonical);
  }, 20_000);

  it("AC-2: a vanished entry without --reattach still refuses, and the fixHint names --reattach", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "noflag");
    await commitIn(session.worktree!, "gone.txt", "gone");
    await rm(session.worktree!, { recursive: true, force: true });

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.data?.["vanished"]).toBe(true);
    expect(data.diagnostics[0]?.fixHint).toContain("--reattach");
    // The branch's unique commits survive — nothing was touched.
    expect((await gitExec(repo, ["rev-parse", "--verify", session.branch!])).exitCode).toBe(0);
    const registry = await readRegistry(ambientIo, await commonGitDir(ambientIo, repo));
    expect(registry.branches.some((b) => b.name === session.branch)).toBe(true);
  }, 20_000);

  it("AC-2/AC-7: --dry-run --reattach reports the FLOW-07 refusal and the target without creating it", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "ghost-preview");
    await commitIn(session.worktree!, "gone.txt", "gone");
    const recorded = session.worktree!;
    await rm(recorded, { recursive: true, force: true });

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: true,
      now: NOW,
      reattach: true,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-07");
    expect(data.diagnostics[0]?.fixHint).toContain("--reattach");
    expect(data.diagnostics[0]?.data?.["wouldReattach"]).toBe(recorded);
    expect(data.wouldReattach).toBe(recorded);
    // AC-7: nothing was created.
    expect(await ambientIo.exists(recorded)).toBe(false);
  }, 20_000);

  it("a recorded path occupied by a foreign tree refuses FLOW-INT-17 — never a silent mix", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "squat");
    await commitIn(session.worktree!, "s.txt", "s");
    const recorded = session.worktree!;
    await rm(recorded, { recursive: true, force: true });
    // Clear the stale worktree registration so git associates no live
    // worktree with the branch, then squat on the recorded path.
    await gitExec(repo, ["worktree", "prune"]);
    await mkdir(recorded, { recursive: true });
    await writeFile(join(recorded, "occupant.txt"), "not the session\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      reattach: true,
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-17");
    expect(data.diagnostics[0]?.message).toContain("occupied");
    // The occupant is untouched.
    expect(await ambientIo.exists(join(recorded, "occupant.txt"))).toBe(true);
  }, 20_000);
});
