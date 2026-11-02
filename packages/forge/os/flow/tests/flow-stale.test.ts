/*
<MODULE_CONTRACT>
<purpose>FLOW-06/07 staleness and registry-mismatch tests (RFC-1487 step 5,
AC-7): an unregistered auto branch whose last commit is 73 h old reports
FLOW-06 while a 71 h one does not; a registered entry with a stale
updatedAt but a fresh commit is clean; registry/git mismatches report
FLOW-07.</purpose>
<non-goals>
  <item>No status-shape coverage — flow-status.test.ts owns the output contract.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 5 — stale/mismatch tests</item>
  <item>RFC-1487: step 5 — flow.discard, flow.status, flow.check FLOW-06/07</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { formatFlowBranch } from "../branch-name.ts";
import { collectFlowCheck } from "../handlers/flow-check.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { commonGitDir, registryPath, updateRegistry } from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-05T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-stale-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await gitExec(dir, ["branch", "develop", "HEAD"]);
  await gitExec(dir, ["switch", "develop"]);
  return dir;
}

/** Create an unregistered auto branch with a commit dated `hoursAgo` before NOW. */
async function staleBranch(repo: string, slug: string, hoursAgo: number): Promise<string> {
  const date = new Date(NOW.getTime() - hoursAgo * 3_600_000);
  const name = formatFlowBranch({ kind: "session", date, seq: 1, slug });
  await gitExec(repo, ["branch", name, "develop"]);
  await gitExec(repo, ["switch", name]);
  await writeFile(join(repo, "s.txt"), slug);
  await gitExec(repo, ["add", "s.txt"]);
  await gitExec(repo, ["commit", "-m", `add ${slug}`], {
    GIT_AUTHOR_DATE: date.toISOString(),
    GIT_COMMITTER_DATE: date.toISOString(),
  });
  await gitExec(repo, ["switch", "develop"]);
  return name;
}

describe("flow.check FLOW-06 (stale)", () => {
  it("reports FLOW-06 for an unregistered auto branch with a 73 h old commit (AC-7)", async () => {
    const repo = await governedRepo();
    const name = await staleBranch(repo, "old-one", 73);
    const outcome = await collectFlowCheck(repo, ambientIo, { now: NOW });
    const flow06 = outcome.diagnostics.filter((d) => d.ruleId === "FLOW-06");
    expect(flow06.some((d) => d.message.includes(name))).toBe(true);
  }, 15_000);

  it("does not report FLOW-06 for a 71 h old branch", async () => {
    const repo = await governedRepo();
    const name = await staleBranch(repo, "fresh-one", 71);
    const outcome = await collectFlowCheck(repo, ambientIo, { now: NOW });
    expect(outcome.diagnostics.some((d) => d.ruleId === "FLOW-06" && d.message.includes(name))).toBe(false);
  }, 15_000);

  it("does not report FLOW-06 for a registered entry with fresh commit but stale updatedAt", async () => {
    const repo = await governedRepo();
    // The branch tip's committer date is real time, so `now` is real too —
    // the fresh commit (not the stale updatedAt) decides.
    const realNow = new Date();
    const session = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "registered",
      brief: null,
      owner: null,
      dryRun: false,
      now: realNow,
    });
    dirs.push(session.worktree!);
    // backdate updatedAt past the threshold; the fresh commit keeps it alive.
    const common = await commonGitDir(ambientIo, repo);
    await updateRegistry(ambientIo, common, (r) => ({
      ...r,
      branches: r.branches.map((b) =>
        b.name === session.branch ? { ...b, updatedAt: "2026-10-01T00:00:00Z" } : b,
      ),
    }));
    const outcome = await collectFlowCheck(repo, ambientIo, { now: realNow });
    expect(outcome.diagnostics.some((d) => d.ruleId === "FLOW-06" && d.message.includes(session.branch!))).toBe(false);
  }, 15_000);
});

describe("flow.check FLOW-07 (registry/git mismatch)", () => {
  it("reports FLOW-07 for a registry entry whose worktree is missing", async () => {
    const repo = await governedRepo();
    const session = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "vanished",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    await rm(session.worktree!, { recursive: true, force: true });
    await gitExec(repo, ["worktree", "prune"]);

    const outcome = await collectFlowCheck(repo, ambientIo, { now: NOW });
    const flow07 = outcome.diagnostics.filter((d) => d.ruleId === "FLOW-07");
    expect(flow07.some((d) => d.message.includes(session.branch!))).toBe(true);
  }, 20_000);

  it("reports FLOW-07 at error severity for a schema-invalid registry", async () => {
    const repo = await governedRepo();
    const common = await commonGitDir(ambientIo, repo);
    await mkdir(join(common, "forge"), { recursive: true });
    await writeFile(registryPath(common), "schema: forge/flow-registry@1\nbranches: [{name: 7}]\n");

    const outcome = await collectFlowCheck(repo, ambientIo, { now: NOW });
    const flow07 = outcome.diagnostics.filter((d) => d.ruleId === "FLOW-07");
    expect(flow07.some((d) => d.severity === "error")).toBe(true);
  }, 15_000);
});
