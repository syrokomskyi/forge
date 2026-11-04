/*
<MODULE_CONTRACT>
<purpose>flow.cut release-prepare hook + pre-tag extract verification tests
(RFC-1502, AC-1..6, AC-9, AC-10): a hooks/release-prepare.sh that edits a
tracked file folds into the release commit (ordinary and fix), a failing
hook refuses FLOW-CUT-12 with the release branch removed, untracked hook
output stays out of the commit as a FLOW-CUT-14 warning, a named package
line extracts at the release commit into a scratch (never the configured
destination) and a failing extract-verify refuses FLOW-CUT-13 leaving
develop and the tags untouched, --dry-run lists the steps, and a refused
fix cut rolls the fix branch back to its pre-release tip so the cut is
rerun-safe.</purpose>
<non-goals>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp
  repos with their own hooks/ and a fake node_modules/.bin/repo-extract
  honoring --dest.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Hooks are written untracked into the primary's hooks/ — runFlowScript reads the primary's copy, so no adoption commit is needed for them.</item>
  <item>Extract failure is injected via a .fail-extract marker the fake checks in $PWD (cwd = primary); verify failure via hooks/extract-verify.sh exiting non-zero.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1502: step 1 — release-prepare + pre-tag verify tests</item>
  <item>RFC-1502: steps 1-5 — release-prepare hook, pre-tag extract verification, ordered steps</item>
  <item>RFC-1502: review r1 — fix-cut rollback on FLOW-CUT-12/13, populated steps[], hook validation, GIT_* env scrub</item>
</CHANGE_SUMMARY>
*/

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { gitExec, initRepo, installFakeRepoExtract, installGuard } from "./helpers.ts";
import { runOrdinaryCut } from "../handlers/flow-cut.ts";
import { fixFlow, runFixCut } from "../handlers/flow-fix.ts";
import { commonGitDir, readRegistry } from "../registry.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 30_000);

async function commitIn(repo: string, file: string, content: string): Promise<void> {
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  const r = await gitExec(repo, ["commit", "-m", `add ${file}`]);
  if (r.exitCode !== 0) throw new Error(`commit failed: ${r.stderr}`);
}

async function sha(repo: string, ref: string): Promise<string> {
  return (await gitExec(repo, ["rev-parse", ref])).stdout.trim();
}

async function writeHook(repo: string, name: string, body: string): Promise<void> {
  const path = join(repo, "hooks", `${name}.sh`);
  await writeFile(path, body);
  await chmod(path, 0o755);
}

/**
 * Adopted repository: guard installed, baseline tag v0.1.0, a tracked.txt to
 * modify, pending work on develop. packageLine adds packages/lib
 * (extract.config.yaml + package.json v2.0.0, baseline tag lib@2.0.0).
 */
async function adoptedRepo(opts?: { packageLine?: boolean }): Promise<{
  repo: string;
  extractLog: string;
}> {
  const repo = await initRepo({ prefix: "flow-cut-prepare-" });
  dirs.push(repo);
  const extractLog = join(repo, "extract.log");
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(join(repo, "package.json"), '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n');
  await writeFile(join(repo, "tracked.txt"), "base\n");
  if (opts?.packageLine) {
    await writeFile(join(repo, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    await mkdir(join(repo, "packages/lib"), { recursive: true });
    await writeFile(
      join(repo, "packages/lib/package.json"),
      '{\n  "name": "lib",\n  "version": "2.0.0"\n}\n',
    );
    await writeFile(
      join(repo, "packages/lib/extract.config.yaml"),
      "schema: extract\ndestName: ac-dest\n",
    );
  }
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "config"]);
  await gitExec(repo, ["switch", "-c", "develop"]);
  await commitIn(repo, "work.txt", "work");
  if (opts?.packageLine) {
    // The lib line needs a pending commit touching its paths — the cut
    // refuses FLOW-CUT-04 on a line with nothing to release. Committed
    // before the guard installs so the pre-guard state can carry it.
    await commitIn(repo, "packages/lib/pending.txt", "lib work");
  }
  await installGuard(repo);
  await gitExec(repo, ["add", "hooks"]);
  const adopt = await gitExec(repo, ["commit", "-m", "adopt"], { FORGE_FLOW_OP: "install" });
  if (adopt.exitCode !== 0) throw new Error(`adoption commit failed: ${adopt.stderr}`);
  await gitExec(repo, ["tag", "-a", "v0.1.0", "main", "-m", "release v0.1.0"]);
  if (opts?.packageLine) {
    await gitExec(repo, ["tag", "-a", "lib@2.0.0", "main", "-m", "release lib@2.0.0"]);
  }
  await installFakeRepoExtract(repo, extractLog);
  return { repo, extractLog };
}

describe("flow.cut — release-prepare hook and pre-tag verify (RFC-1502)", () => {
  it("AC-1: a tracked change from release-prepare lands in the release commit", async () => {
    const { repo } = await adoptedRepo();
    await writeHook(repo, "release-prepare", "#!/bin/sh\nset -eu\necho prepared >> tracked.txt\n");

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });

    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.released).toBe(true);
    const shown = await gitExec(repo, ["show", "main:tracked.txt"]);
    expect(shown.stdout).toContain("prepared");
  }, 30_000);

  it("AC-2: a failing release-prepare refuses FLOW-CUT-12 and removes the branch", async () => {
    const { repo } = await adoptedRepo();
    await writeHook(repo, "release-prepare", "#!/bin/sh\necho boom >&2\nexit 2\n");
    const tipBefore = await sha(repo, "develop");

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });

    expect(data.released).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-12");
    expect(data.diagnostics[0]?.message).toContain("boom");
    expect(await sha(repo, "develop")).toBe(tipBefore);
    const branches = (await gitExec(repo, ["branch", "--list", "auto/*"])).stdout.trim();
    expect(branches).toBe("");
  }, 30_000);

  it("AC-10: an untracked file the hook leaves stays out of the commit (FLOW-CUT-14)", async () => {
    const { repo } = await adoptedRepo();
    await writeHook(
      repo,
      "release-prepare",
      "#!/bin/sh\nset -eu\necho prepared >> tracked.txt\necho stray > stray-new.txt\n",
    );

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });

    expect(data.released).toBe(true);
    const warn = data.diagnostics.find((d) => d.ruleId === "FLOW-CUT-14");
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toContain("stray-new.txt");
    const listed = await gitExec(repo, ["ls-tree", "-r", "--name-only", "main"]);
    expect(listed.stdout).not.toContain("stray-new.txt");
    expect(listed.stdout).toContain("tracked.txt");
  }, 30_000);

  it("AC-3+AC-4: a failing extract-verify refuses FLOW-CUT-13 — no tag, develop untouched", async () => {
    const { repo } = await adoptedRepo({ packageLine: true });
    await writeHook(repo, "extract-verify", "#!/bin/sh\necho verify-boom >&2\nexit 4\n");
    const tipBefore = await sha(repo, "develop");

    const data = await runOrdinaryCut(repo, ambientIo, { lines: ["lib"], dryRun: false });

    expect(data.released).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-13");
    expect(data.diagnostics[0]?.message).toContain("lib");
    expect(await sha(repo, "develop")).toBe(tipBefore);
    expect((await gitExec(repo, ["rev-parse", "--verify", "-q", "refs/tags/lib@2.0.1"])).exitCode).not.toBe(0);
    expect((await gitExec(repo, ["rev-parse", "--verify", "-q", "refs/tags/v0.1.1"])).exitCode).not.toBe(0);
    const branches = (await gitExec(repo, ["branch", "--list", "auto/*"])).stdout.trim();
    expect(branches).toBe("");
  }, 30_000);

  it("AC-3b: a failing extract step also refuses FLOW-CUT-13", async () => {
    const { repo } = await adoptedRepo({ packageLine: true });
    await writeFile(join(repo, ".fail-extract"), "1");

    const data = await runOrdinaryCut(repo, ambientIo, { lines: ["lib"], dryRun: false });

    expect(data.released).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-13");
  }, 30_000);

  it("AC-5: the configured extract destination gains no commit — scratch only", async () => {
    const { repo, extractLog } = await adoptedRepo({ packageLine: true });
    const data = await runOrdinaryCut(repo, ambientIo, { lines: ["lib"], dryRun: false });

    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.released).toBe(true);
    // The fake extract ran with --dest <scratch>, never the configured dest.
    const argv = await readFile(extractLog, "utf8");
    expect(argv).toContain("--dest");
    expect(argv).not.toContain("ac-dest");
    // The configured destination (anchored at dirname(repo)) does not exist.
    const configuredDest = join(tmpdir(), "packages", "ac-dest");
    expect(existsSync(configuredDest)).toBe(false);
  }, 30_000);

  it("AC-6: --dry-run lists release-prepare and extract-verify:<line>", async () => {
    const { repo } = await adoptedRepo({ packageLine: true });
    const data = await runOrdinaryCut(repo, ambientIo, { lines: ["lib"], dryRun: true });

    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.steps).toContain("release-prepare");
    expect(data.steps).toContain("extract-verify:lib");
  }, 20_000);

  it("AC-9: a tracked change from release-prepare lands in a fix release commit", async () => {
    const { repo } = await adoptedRepo();
    // First release so a fix can open on the tagged main.
    const first = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(first.released).toBe(true);

    const fix = await fixFlow(repo, ambientIo, { slug: "fix-prepare", brief: "t", dryRun: false });
    expect(fix.opened).toBe(true);
    const fixBranch = fix.branch!;
    const wt = fix.worktree!;
    dirs.push(wt);
    await commitIn(wt, "hotfix.txt", "fix");

    await writeHook(repo, "release-prepare", "#!/bin/sh\nset -eu\necho fix-prepared >> tracked.txt\n");

    const common = await commonGitDir(ambientIo, repo);
    const entry = (await readRegistry(ambientIo, common)).branches.find((b) => b.name === fixBranch);
    const data = await runFixCut(repo, ambientIo, { entry: entry!, linesGiven: false, dryRun: false });

    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.released).toBe(true);
    const shown = await gitExec(repo, ["show", "main:tracked.txt"]);
    expect(shown.stdout).toContain("fix-prepared");
  }, 60_000);

  it("fix-mode FLOW-CUT-12 rolls the fix branch back — the cut re-runs cleanly", async () => {
    const { repo } = await adoptedRepo();
    const first = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(first.released).toBe(true);

    const fix = await fixFlow(repo, ambientIo, { slug: "fix-rollback", brief: "t", dryRun: false });
    const fixBranch = fix.branch!;
    const wt = fix.worktree!;
    dirs.push(wt);
    await commitIn(wt, "hotfix.txt", "fix");

    await writeHook(repo, "release-prepare", "#!/bin/sh\necho boom >&2\nexit 2\n");
    const common = await commonGitDir(ambientIo, repo);
    const entry = (await readRegistry(ambientIo, common)).branches.find((b) => b.name === fixBranch);
    const tipBefore = await sha(repo, fixBranch);

    const failed = await runFixCut(repo, ambientIo, { entry: entry!, linesGiven: false, dryRun: false });
    expect(failed.released).toBe(false);
    expect(failed.diagnostics[0]?.ruleId).toBe("FLOW-CUT-12");
    // Rolled back: tip unchanged, worktree clean — a re-run cannot hit
    // FLOW-CUT-07 on the leftover version writes.
    expect(await sha(repo, fixBranch)).toBe(tipBefore);
    expect((await gitExec(wt, ["status", "--porcelain"])).stdout.trim()).toBe("");

    // Re-run with a working hook — no manual recovery needed.
    await writeHook(repo, "release-prepare", "#!/bin/sh\nset -eu\necho fix-prepared >> tracked.txt\n");
    const retried = await runFixCut(repo, ambientIo, { entry: entry!, linesGiven: false, dryRun: false });
    expect(retried.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(retried.released).toBe(true);
  }, 60_000);

  it("fix-mode FLOW-CUT-13 removes the failed release commit — the cut re-runs cleanly", async () => {
    const { repo } = await adoptedRepo({ packageLine: true });
    const first = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(first.released).toBe(true);

    const fix = await fixFlow(repo, ambientIo, { slug: "fix-rollback13", brief: "t", dryRun: false });
    const fixBranch = fix.branch!;
    const wt = fix.worktree!;
    dirs.push(wt);
    // Touch the lib line so the fix releases it and extract-verify runs.
    await commitIn(wt, "packages/lib/hotfix.txt", "fix");

    await writeHook(repo, "extract-verify", "#!/bin/sh\necho verify-boom >&2\nexit 4\n");
    const common = await commonGitDir(ambientIo, repo);
    const entry = (await readRegistry(ambientIo, common)).branches.find((b) => b.name === fixBranch);
    const tipBefore = await sha(repo, fixBranch);

    const failed = await runFixCut(repo, ambientIo, { entry: entry!, linesGiven: false, dryRun: false });
    expect(failed.released).toBe(false);
    expect(failed.diagnostics[0]?.ruleId).toBe("FLOW-CUT-13");
    // The failed chore(release) commit is gone — a re-run cannot produce an
    // empty release commit (FLOW-CUT-01) or stack a duplicate.
    expect(await sha(repo, fixBranch)).toBe(tipBefore);
    expect((await gitExec(wt, ["status", "--porcelain"])).stdout.trim()).toBe("");

    await rm(join(repo, "hooks", "extract-verify.sh"));
    const retried = await runFixCut(repo, ambientIo, { entry: entry!, linesGiven: false, dryRun: false });
    expect(retried.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(retried.released).toBe(true);
  }, 60_000);
});
