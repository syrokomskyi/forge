/*
<MODULE_CONTRACT>
<purpose>flow.open tests (RFC-1487 step 3, AC-1/AC-2): the session worktree
lands beside the primary as &lt;repo&gt;@&lt;branch-slug&gt; from the develop
tip, NN increments across local and remote-tracking names, refusals
FLOW-OPEN-10/03/05, and a failing setup script exits 1 while keeping the
worktree and registry entry.</purpose>
<non-goals>
  <item>No lifecycle coverage beyond open — integrate/discard have their own files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 3 — flow.open tests</item>
  <item>RFC-1487: step 3 — flow.open with NN assignment over local/remote/registry names</item>
  <item>RFC-1536: evidence — routing/warning tests, FLOW-OPEN-10 validation renumber, owning-worktree doc rule, frictions F-0091/F-0096/F-0106/F-0119 addressed</item>
  <item>RFC-1599: sweep primary dirt into opened worktrees + bind session writes to the owning checkout (RFC-1599)</item>
  <item>RFC-1616: close RFC-1616 r11 trust-boundary counterexamples

Independent clean-context verification (round 11, candidate 029219ca9)
returned REFUTED with seven live counterexamples against the
r10-remediated channel — this commit closes all of them.

- `.git/info/attributes` joins the shape-violation paths (CX-125): the
  r6 reasoning covered only program reach, but working-tree-encoding /
  text / eol / ident are built-in clean-side conversions that rewrite
  what the zero-stat index content-hash sees with no external program.
- Index-consulting classification is argv-exact (CX-126/127/128):
  isIndexConsultingRead replaces the token-counting isUnprovenIndexRead —
  ambiguous diff forms (a nonrev second positional is a pathspec, not a
  rev) refuse under an unproven index, describe --dirty/--broken are
  index-consuming, and grep is parsed option-aware so a worktree grep
  with no rev token refuses while `-e`/`-f` + rev tree greps proceed.
- The verifier claims index has no discoverable path (CX-129): a
  self-serialized DIRC v2 image lives in an anonymous O_TMPFILE inode
  opened on os.tmpdir(), handed to git as GIT_INDEX_FILE=/dev/fd/<n>
  through a freshly opened independent file description per spawn;
  the named flat-file fallback re-proves its bytes against the expected
  image before every spawn, and child descriptors close on every return
  path.
- `cat-file --batch` specs are sanitized (CX-130): runBatchBytes rejects
  empty specs and any spec containing \n/\r/\0 (and `:`-leading index
  specs under an unproven index), answering positional nulls so the
  record stream can never desynchronize spec attribution.
- Trusted transports refuse file-class targets and URL rewrites
  (CX-131): url.*.insteadOf / .pushInsteadOf are refused at preflight,
  and ls-remote/fetch spawn with protocol.file.allow=never so file:
  URLs and bare-path remotes fail honestly; the pin is transport-only
  so verifierScratchGit's judged `clone <path>` still works. Test
  origins moved from local path/file remotes to a loopback git daemon
  so fixtures keep exercising real fetch/ls-remote behavior.

The port commit that follows carries the ported cx11 probe file plus
the round-11 acceptance report.</item>
</CHANGE_SUMMARY>
*/

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { canonicalRepoDir } from "../../../src/utils/repo-path.ts";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { formatFlowBranch } from "../branch-name.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { commonGitDir, readRegistry } from "../registry.ts";
import { gitExec, initRepo, remoteAddGitDaemon } from "./helpers.ts";

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
  // Committed marker — the primary starts clean; an uncommitted forge.yaml
  // would be swept into every worktree the fixture opens (RFC-1599).
  await gitExec(dir, ["add", "forge.yaml"]);
  await gitExec(dir, ["commit", "-m", "governed marker"]);
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
    // Product answers in the canonical frame (git's worktree list) — on
    // Windows the mkdtemp 8.3 alias resolves to a different spelling of the
    // same directory, so comparisons go through realpath.
    const expectedPath = join(dirname(repo), `${basename(repo)}@${name.replaceAll("/", "-")}`);
    expect(data.branch).toBe(name);
    expect(data.worktree).toBe(canonicalRepoDir(expectedPath));
    expect(data.worktree?.startsWith(dirname(canonicalRepoDir(repo)))).toBe(true);
    dirs.push(expectedPath);
    expect(await sha(repo, name)).toBe(developSha);
    expect(data.opened).toBe(true);

    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    const entry = registry.branches.find((b) => b.name === name);
    expect(entry?.worktree).toBe(canonicalRepoDir(expectedPath));
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
    await remoteAddGitDaemon(repo, origin);
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

  it("refuses FLOW-OPEN-10 on an invalid slug", async () => {
    const repo = await governedRepo();
    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "Bad_Slug!",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-OPEN-10");
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
    const target = join(dirname(repo), `${basename(repo)}@${name.replaceAll("/", "-")}`);
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
    // Committed — an uncommitted hook sweeps into the worktree and the
    // primary-side lookup skips it (RFC-1599).
    await gitExec(repo, ["add", "hooks/worktree-setup.sh"]);
    await gitExec(repo, ["commit", "-m", "failing setup hook"]);

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

  it("sweeps tracked mutations + untracked files into the worktree index and cleans the primary (RFC-1599 AC-1)", async () => {
    const repo = await governedRepo();
    // Tracked mutation + staged new file + unstaged deletion + untracked file.
    await gitExec(repo, ["add", "forge.yaml"]);
    await writeFile(join(repo, "kept.ts"), "export const kept = 1;\n");
    await writeFile(join(repo, "gone.ts"), "export const gone = 1;\n");
    await gitExec(repo, ["add", "kept.ts", "gone.ts"]);
    await gitExec(repo, ["commit", "-m", "seed tracked files"]);
    // The worktree bases on develop — move it to the seeded tip so the
    // swept paths stage as M/D against it, not as new files.
    await gitExec(repo, ["branch", "-f", "develop", "HEAD"]);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\ndirty: true\n');
    await writeFile(join(repo, "staged-new.ts"), "export const staged = 1;\n");
    await gitExec(repo, ["add", "staged-new.ts"]);
    await rm(join(repo, "gone.ts"));
    await writeFile(join(repo, "loose.txt"), "untracked\n");
    // Binary content — NULs and high bytes must survive the sweep byte-exact.
    const blob = Buffer.concat([Buffer.from([0x00, 0xff, 0xd8, 0x00, 0x0a]), randomBytes(64)]);
    await writeFile(join(repo, "blob.bin"), blob);

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
    expect(data.sweep?.refused).toEqual({});
    expect(new Set(data.sweep?.swept)).toEqual(
      new Set(["forge.yaml", "staged-new.ts", "gone.ts", "loose.txt", "blob.bin"]),
    );

    const wt = data.worktree!;
    // Worktree index carries the swept state.
    const wtStatus = await gitExec(wt, ["status", "--porcelain"]);
    const staged = wtStatus.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.slice(0, 2));
    expect(staged).toEqual(["A ", "M ", "D ", "A ", "A "]);
    expect(await ambientIo.readFile(join(wt, "forge.yaml"))).toContain("dirty: true");
    // Binary bytes round-trip — the sweep never stringifies content.
    expect(await ambientIo.readFileBytes(join(wt, "blob.bin"))).toEqual(blob);
    // The primary is clean — every swept path restored to HEAD or removed.
    const primaryStatus = await gitExec(repo, ["status", "--porcelain", "-uall"]);
    expect(primaryStatus.stdout.trim()).toBe("");
    expect(await ambientIo.readFile(join(repo, "forge.yaml"))).toBe(
      'schema: "forge/workspace@1"\n',
    );
    expect(await ambientIo.exists(join(repo, "gone.ts"))).toBe(true);
    expect(await ambientIo.exists(join(repo, "staged-new.ts"))).toBe(false);
    expect(await ambientIo.exists(join(repo, "loose.txt"))).toBe(false);
    expect(await ambientIo.exists(join(repo, "blob.bin"))).toBe(false);
    // A warning names the swept paths — the mutation is surfaced, not silent.
    const warning = data.diagnostics.find(
      (d) => d.ruleId === "FLOW-OPEN-01" && d.severity === "warning",
    );
    expect(warning?.message).toContain("swept 5 path(s)");
  }, 15_000);

  it("refuses FLOW-OPEN-01 on a mid-merge primary without mutating either checkout (RFC-1599 AC-2)", async () => {
    const repo = await governedRepo();
    // Forge a merge-in-progress marker — the detector keys on MERGE_HEAD.
    await writeFile(join(repo, ".git", "MERGE_HEAD"), `${await sha(repo, "develop")}\n`);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\ndirty: true\n');

    const data = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "mid-op",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    expect(data.opened).toBe(false);
    expect(data.branch).toBeNull();
    const refusal = data.diagnostics.find((d) => d.ruleId === "FLOW-OPEN-01");
    expect(refusal?.severity).toBe("error");
    expect(refusal?.message).toContain("mid-merge");
    // Zero mutation — the dirt stays in the primary, no worktree was created.
    expect(await ambientIo.readFile(join(repo, "forge.yaml"))).toContain("dirty: true");
    const registry = await readRegistry(ambientIo, await commonGitDir(ambientIo, repo)).catch(
      () => null,
    );
    expect(registry === null || registry.branches.length === 0).toBe(true);
  }, 15_000);

  it("emits no FLOW-OPEN-01 when the primary is clean (RFC-1536 AC-2)", async () => {
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
    expect(data.diagnostics.some((d) => d.ruleId === "FLOW-OPEN-01")).toBe(false);
  }, 15_000);
});
