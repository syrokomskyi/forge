/*
<MODULE_CONTRACT>
<purpose>flow.status tests (RFC-1487 step 5): the output contract — primary
path/branch/clean, and per-branch registered/worktree/dirty/ahead/behind/
lastCommitAt/stale/held fields matching the RFC's example shape.</purpose>
<non-goals>
  <item>No FLOW-06/07 diagnostic coverage — flow-stale.test.ts owns it.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 5 — flow.status tests</item>
  <item>RFC-1487: step 5 — flow.discard, flow.status, flow.check FLOW-06/07</item>
</CHANGE_SUMMARY>
*/

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { canonicalRepoDir } from "../../../src/utils/repo-path.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { collectFlowStatus } from "../handlers/flow-status.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

describe("flow.status", () => {
  it("reports primary state and the per-branch contract shape", async () => {
    const repo = await initRepo({ prefix: "flow-status-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await gitExec(repo, ["branch", "develop", "HEAD"]);
    await gitExec(repo, ["switch", "develop"]);

    const session = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "shape",
      brief: "status test",
      owner: null,
      dryRun: false,
      now: NOW,
    });
    dirs.push(session.worktree!);
    await writeFile(join(session.worktree!, "x.txt"), "x");
    await gitExec(session.worktree!, ["add", "x.txt"]);
    await gitExec(session.worktree!, ["commit", "-m", "add x.txt"]);
    await writeFile(join(session.worktree!, "seed.txt"), "tracked edit\n"); // dirty: 1
    await writeFile(join(repo, "d.txt"), "d");
    await gitExec(repo, ["add", "d.txt"]);
    await gitExec(repo, ["commit", "-m", "add d.txt"]); // develop ahead by 1

    const outcome = await collectFlowStatus(repo, ambientIo, { now: NOW });
    // primary.path is canonicalized (git's worktree frame) — compare the
    // real spelling of the same directory, not the mkdtemp 8.3 alias.
    expect(outcome.data.primary.path).toBe(canonicalRepoDir(repo));
    expect(outcome.data.primary.branch).toBe("develop");
    expect(outcome.data.primary.clean).toBe(true);

    const row = outcome.data.branches.find((b) => b.name === session.branch);
    expect(row).toBeDefined();
    expect(row?.registered).toBe(true);
    expect(row?.kind).toBe("session");
    expect(row?.worktree).toBe(session.worktree);
    expect(row?.worktreeExists).toBe(true);
    expect(row?.dirty).toBe(1);
    expect(row?.aheadOfDevelop).toBe(1);
    expect(row?.behindDevelop).toBe(1);
    expect(row?.lastCommitAt).not.toBeNull();
    expect(row?.stale).toBe(false);
    expect(row?.held).toBeNull();
  }, 20_000);

  it("lists an unregistered auto branch with registered: false", async () => {
    const repo = await initRepo({ prefix: "flow-status-unreg-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await gitExec(repo, ["branch", "develop", "HEAD"]);
    await gitExec(repo, ["switch", "develop"]);
    await gitExec(repo, ["branch", "auto/session-261102-01-manual", "develop"]);

    const outcome = await collectFlowStatus(repo, ambientIo, { now: NOW });
    const row = outcome.data.branches.find((b) => b.name === "auto/session-261102-01-manual");
    expect(row?.registered).toBe(false);
    expect(row?.worktree).toBeNull();
    expect(row?.worktreeExists).toBe(false);
  }, 15_000);
});
