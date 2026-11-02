/*
<MODULE_CONTRACT>
<purpose>flow.open tests (RFC-1487 step 3, AC-1/AC-2): the session worktree
lands beside the primary as &lt;repo&gt;@&lt;branch-slug&gt; from the develop
tip, NN increments across local and remote-tracking names, refusals
FLOW-OPEN-01/03/05, and a failing setup script exits 1 while keeping the
worktree and registry entry.</purpose>
<non-goals>
  <item>No lifecycle coverage beyond open — integrate/discard have their own files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 3 — flow.open tests</item>
  <item>RFC-1487: step 3 — flow.open with NN assignment over local/remote/registry names</item>
</CHANGE_SUMMARY>
*/

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { formatFlowBranch } from "../branch-name.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { commonGitDir, readRegistry } from "../registry.ts";
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
  const dir = await initRepo({ prefix: "flow-open-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await gitExec(dir, ["branch", "develop", "HEAD"]);
  return dir;
}

async function sha(repo: string, ref: string): Promise<string> {
  const r = await gitExec(repo, ["rev-parse", ref]);
  return r.stdout.trim();
}

describe("flow.open", () => {
  it("creates the branch at develop's tip in <repo>@<branch-slug> (AC-1)", async () => {
    const repo = await governedRepo();
    const developSha = await sha(repo, "develop");

    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "forge-flow",
      brief: "RFC-1487",
      owner: null,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics).toEqual([]);
    const name = formatFlowBranch({ kind: "session", date: NOW, seq: 1, slug: "forge-flow" });
    const expectedPath = join(dirname(repo), `${repo.split("/").pop()}@${name.replaceAll("/", "-")}`);
    expect(data.branch).toBe(name);
    expect(data.worktree).toBe(expectedPath);
    expect(data.worktree?.startsWith(dirname(repo))).toBe(true);
    dirs.push(expectedPath);
    expect(await sha(repo, name)).toBe(developSha);
    expect(data.opened).toBe(true);

    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    const entry = registry.branches.find((b) => b.name === name);
    expect(entry?.worktree).toBe(expectedPath);
    expect(entry?.baseSha).toBe(developSha);
    expect(entry?.owner).toEqual({ kind: "session", id: "unspecified" });
    expect(entry?.held).toBeNull();
  }, 15_000);

  it("assigns NN 02 when -01 exists locally (AC-2)", async () => {
    const repo = await governedRepo();
    const first = formatFlowBranch({ kind: "session", date: NOW, seq: 1, slug: "other" });
    await gitExec(repo, ["branch", first, "develop"]);

    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "second",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.branch).toBe(
      formatFlowBranch({ kind: "session", date: NOW, seq: 2, slug: "second" }),
    );
    if (data.worktree) dirs.push(data.worktree);
  }, 15_000);

  it("assigns NN 02 when -01 exists only on a remote-tracking ref (AC-2)", async () => {
    const origin = await mkdtemp(join(tmpdir(), "flow-open-origin-"));
    dirs.push(origin);
    await gitExec(origin, ["init", "--bare"]);
    const repo = await governedRepo();
    const first = formatFlowBranch({ kind: "session", date: NOW, seq: 1, slug: "remote-one" });
    await gitExec(repo, ["branch", first, "develop"]);
    await gitExec(repo, ["remote", "add", "origin", origin]);
    const push = await gitExec(repo, ["push", "-u", "origin", first, "develop"]);
    expect(push.exitCode, push.stderr).toBe(0);
    await gitExec(repo, ["branch", "-D", first]);

    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "from-remote",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.branch).toBe(
      formatFlowBranch({ kind: "session", date: NOW, seq: 2, slug: "from-remote" }),
    );
    if (data.worktree) dirs.push(data.worktree);
  }, 15_000);

  it("refuses FLOW-OPEN-01 on an invalid slug", async () => {
    const repo = await governedRepo();
    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "Bad_Slug!",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-OPEN-01");
    expect(data.opened).toBe(false);
  }, 15_000);

  it("refuses FLOW-OPEN-05 for --kind task without --owner", async () => {
    const repo = await governedRepo();
    const data = await openFlowBranch(repo, ambientIo, {
      kind: "task",
      slug: "port-ci",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-OPEN-05");
  }, 15_000);

  it("refuses FLOW-OPEN-03 when the target path exists", async () => {
    const repo = await governedRepo();
    const name = formatFlowBranch({ kind: "session", date: NOW, seq: 1, slug: "taken" });
    const target = join(dirname(repo), `${repo.split("/").pop()}@${name.replaceAll("/", "-")}`);
    await mkdir(target, { recursive: true });
    dirs.push(target);

    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "taken",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-OPEN-03");
  }, 15_000);

  it("reports a failing setup script with exit 1 and keeps worktree + entry", async () => {
    const repo = await governedRepo();
    await mkdir(join(repo, "hooks"), { recursive: true });
    await writeFile(join(repo, "hooks", "worktree-setup.sh"), "#!/bin/sh\nexit 3\n");

    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "setup-fail",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    if (data.worktree) dirs.push(data.worktree);
    expect(data.setup?.status).toBe("failed");
    expect(data.setup?.exitCode).toBe(3);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-OPEN-07");
    expect(data.opened).toBe(true);
    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    expect(registry.branches.some((b) => b.name === data.branch)).toBe(true);
  }, 15_000);
});
