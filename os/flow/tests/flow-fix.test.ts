/*
<MODULE_CONTRACT>
<purpose>flow.fix + fix-mode flow.cut tests (RFC-1490): a fix branch opens
at the main tip on a release baseline (FLOW-FIX-01..04 refusals), then
flow.cut inside it releases the patch into main through the gate, tags it,
tears the branch down and runs the back-merge (AC-13..16). Also covers the
patch-only level gate FLOW-CUT-10 and the --lines rejection FLOW-CUT-09.</purpose>
<non-goals>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The fix-open fixture ends a completed ordinary cut so main sits exactly on the repository line's last-tag commit — FLOW-FIX-02's required baseline state.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 6 — fix open, patch release, and refusal tests</item>
  <item>RFC-1490: step 6 — flow.fix + fix-mode cut (patch-only, rebase on moved main, gate target main, trailing back-merge)</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { commonGitDir, readRegistry, type FlowRegistryEntry } from "../registry.ts";
import { gitExec, initRepo, installGuard } from "./helpers.ts";
import { runOrdinaryCut } from "../handlers/flow-cut.ts";
import { fixFlow, runFixCutWithBackmerge } from "../handlers/flow-fix.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function sha(repo: string, ref: string): Promise<string> {
  return (await gitExec(repo, ["rev-parse", ref])).stdout.trim();
}

/** Adopted repo with one completed cut — main sits on the v0.1.1 tag. */
async function releasedRepo(): Promise<string> {
  const repo = await initRepo({ prefix: "flow-fix-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(
    join(repo, "package.json"),
    '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
  );
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "config"]);
  await gitExec(repo, ["switch", "-c", "develop"]);
  await installGuard(repo);
  await gitExec(repo, ["add", "hooks"]);
  await gitExec(repo, ["commit", "-m", "adopt"], { FORGE_FLOW_OP: "install" });
  await gitExec(repo, ["tag", "-a", "v0.1.0", "main", "-m", "release v0.1.0"]);
  const cut = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
  expect(cut.diagnostics).toEqual([]);
  expect(cut.tags).toEqual(["v0.1.1"]);
  return repo;
}

async function fixEntry(repo: string, branch: string | null): Promise<FlowRegistryEntry> {
  const common = await commonGitDir(ambientIo, repo);
  const registry = await readRegistry(ambientIo, common);
  const entry = registry.branches.find((b) => b.name === branch);
  expect(entry).toBeDefined();
  return entry!;
}

async function commitIn(wt: string, file: string, content: string, trailer?: string): Promise<void> {
  await writeFile(join(wt, file), content);
  await gitExec(wt, ["add", file]);
  const args = ["commit", "-m", `add ${file}`];
  if (trailer !== undefined) args.push("--trailer", trailer);
  const r = await gitExec(wt, args, { FORGE_FLOW_OP: "" });
  if (r.exitCode !== 0) throw new Error(`commit in ${wt} failed: ${r.stderr}`);
}

describe("flow.fix", () => {
  it("opens auto/fix-… at the main tip with a kind:fix entry", async () => {
    const repo = await releasedRepo();
    const data = await fixFlow(repo, ambientIo, {
      slug: "null-guard",
      brief: null,
      dryRun: false,
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.opened).toBe(true);
    expect(data.branch).toMatch(/^auto\/fix-\d{6}-\d{2}-null-guard$/);
    expect(data.baseSha).toBe(await sha(repo, "main"));
    const entry = await fixEntry(repo, data.branch);
    expect(entry.kind).toBe("fix");
    expect(entry.base).toBe("main");
    dirs.push(data.worktree!);
  }, 30_000);

  it("fix-mode cut releases the patch into main, tags it, tears down, back-merges", async () => {
    const repo = await releasedRepo();
    const fix = await fixFlow(repo, ambientIo, { slug: "hotfix", brief: null, dryRun: false });
    dirs.push(fix.worktree!);
    await commitIn(fix.worktree!, "hot.txt", "fix");
    const entry = await fixEntry(repo, fix.branch);

    const data = await runFixCutWithBackmerge(repo, ambientIo, { entry, linesGiven: false, dryRun: false });

    expect(data.diagnostics).toEqual([]);
    expect(data.released).toBe(true);
    expect(data.mode).toBe("fix");
    expect(data.tags).toEqual(["v0.1.2"]);
    // main advanced to the fix tip; the fix branch and worktree are gone.
    const mainSha = await sha(repo, "main");
    expect(data.mainTip).toBe(mainSha);
    expect(await sha(repo, "v0.1.2^{}")).toBe(mainSha);
    expect((await gitExec(repo, ["rev-parse", "--verify", "-q", `refs/heads/${fix.branch}`])).exitCode).not.toBe(0);
    // Back-merge landed the port into develop.
    expect(data.backmerge).toBe("merged");
    const parents = (await gitExec(repo, ["rev-list", "--parents", "-1", "develop"])).stdout.trim().split(/\s+/);
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(mainSha);
    const subject = (await gitExec(repo, ["log", "-1", "--format=%s", "develop"])).stdout.trim();
    expect(subject).toBe("release v0.1.2 → develop");
    // Registry carries neither fix nor port entries.
    const common = await commonGitDir(ambientIo, repo);
    expect((await readRegistry(ambientIo, common)).branches).toEqual([]);
  }, 120_000);

  it("refuses FLOW-CUT-10 when a fix commit demands minor", async () => {
    const repo = await releasedRepo();
    await mkdir(join(repo, "docs/rfcs"), { recursive: true });
    await writeFile(
      join(repo, "docs/rfcs/rfc-1400-test.md"),
      "---\nid: RFC-1400\ntitle: test\nstatus: accepted\nversionBump: minor\n---\n\n# RFC-1400\n",
    );
    const fix = await fixFlow(repo, ambientIo, { slug: "minorfix", brief: null, dryRun: false });
    dirs.push(fix.worktree!);
    await commitIn(fix.worktree!, "hot.txt", "x", "X-RFC: RFC-1400");
    const entry = await fixEntry(repo, fix.branch);

    const data = await runFixCutWithBackmerge(repo, ambientIo, { entry, linesGiven: false, dryRun: false });
    expect(data.released).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-10");
  }, 30_000);

  it("refuses FLOW-CUT-09 when --lines is passed to a fix cut", async () => {
    const repo = await releasedRepo();
    const fix = await fixFlow(repo, ambientIo, { slug: "linesfix", brief: null, dryRun: false });
    dirs.push(fix.worktree!);
    const entry = await fixEntry(repo, fix.branch);
    const data = await runFixCutWithBackmerge(repo, ambientIo, { entry, linesGiven: true, dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-09");
  }, 30_000);

  it("refuses FLOW-CUT-04 when the fix carries no commits", async () => {
    const repo = await releasedRepo();
    const fix = await fixFlow(repo, ambientIo, { slug: "emptyfix", brief: null, dryRun: false });
    dirs.push(fix.worktree!);
    const entry = await fixEntry(repo, fix.branch);
    const data = await runFixCutWithBackmerge(repo, ambientIo, { entry, linesGiven: false, dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-04");
  }, 30_000);

  it("refuses FLOW-FIX-02 when main moved past its last release", async () => {
    const repo = await releasedRepo();
    // Untagged plumbing commit on main.
    const tree = (await gitExec(repo, ["rev-parse", "main^{tree}"])).stdout.trim();
    const hot = (await gitExec(repo, ["commit-tree", tree, "-p", "main", "-m", "untagged"])).stdout.trim();
    await gitExec(repo, ["update-ref", "refs/heads/main", hot]);

    const data = await fixFlow(repo, ambientIo, { slug: "toofix", brief: null, dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-FIX-02");
  }, 30_000);

  it("refuses FLOW-FIX-04 while a back-merge is pending", async () => {
    const repo = await releasedRepo();
    // Tagged main-side release ahead of develop → pending back-merge.
    const tmp = await mkdtemp(join(tmpdir(), "flow-fix-main-"));
    dirs.push(tmp);
    await gitExec(repo, ["worktree", "add", "--detach", tmp, "main"]);
    await writeFile(join(tmp, "later.txt"), "x");
    await gitExec(tmp, ["add", "later.txt"]);
    await gitExec(tmp, ["commit", "-m", "main-side"], { FORGE_FLOW_OP: "install" });
    const sha2 = await sha(tmp, "HEAD");
    await gitExec(repo, ["tag", "-a", "v0.1.2", sha2, "-m", "release v0.1.2"]);
    await gitExec(repo, ["update-ref", "refs/heads/main", sha2]);
    await gitExec(repo, ["worktree", "remove", "--force", tmp]);

    const data = await fixFlow(repo, ambientIo, { slug: "latefix", brief: null, dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-FIX-04");
  }, 30_000);
});
