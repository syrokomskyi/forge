/*
<MODULE_CONTRACT>
<purpose>pre-push guard tests (RFC-1491, AC-4): a plain git push in an adopted
repository is refused with FLOW-GUARD-05 naming the digest remedy;
FORGE_FLOW_OP=push passes; FORGE_FLOW_OP=push on a commit path refuses with
FLOW-GUARD-04 (per-mode closed vocabulary).</purpose>
<non-goals>
  <item>No digest/push command coverage — flow-digest/flow-push tests own that.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 2 — pre-push guard tests</item>
  <item>RFC-1491: step 2 — pre-push guard mode, install steps pre-push + markers, FLOW-10</item>
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitExec, initRepo, installGuard, remoteAddGitDaemon } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

/** Adopted repo with a bare origin — pushes are hook-guarded. */
async function adoptedWithOrigin(): Promise<{ repo: string; origin: string }> {
  const repo = await initRepo({ prefix: "flow-push-guard-" });
  dirs.push(repo);
  await installGuard(repo);
  await gitExec(repo, ["add", "hooks"]);
  const adopt = await gitExec(repo, ["commit", "-m", "adopt"], {
    FORGE_FLOW_OP: "install",
  });
  if (adopt.exitCode !== 0) throw new Error(`adopt commit failed: ${adopt.stderr}`);
  await gitExec(repo, ["switch", "-c", "develop"]);

  const origin = await mkdtemp(join(tmpdir(), "flow-push-origin-"));
  dirs.push(origin);
  const bare = await gitExec(origin, ["init", "--bare", "-b", "develop", "."]);
  if (bare.exitCode !== 0) throw new Error(`bare init failed: ${bare.stderr}`);
  await remoteAddGitDaemon(repo, origin);
  return { repo, origin };
}

describe("flow-guard pre-push (RFC-1491)", () => {
  it("refuses a plain git push with FLOW-GUARD-05 and the digest remedy (AC-4)", async () => {
    const { repo } = await adoptedWithOrigin();
    const push = await gitExec(repo, ["push", "origin", "develop"], {
      FORGE_FLOW_OP: "",
    });
    expect(push.exitCode).not.toBe(0);
    expect(push.stderr).toContain("FLOW-GUARD-05");
    expect(push.stderr).toContain("flow.digest");
  }, 30_000);

  it("accepts the push under FORGE_FLOW_OP=push", async () => {
    const { repo, origin } = await adoptedWithOrigin();
    const push = await gitExec(repo, ["push", "-u", "origin", "develop"], {
      FORGE_FLOW_OP: "push",
    });
    expect(push.exitCode, push.stderr).toBe(0);
    const remote = await gitExec(origin, ["rev-parse", "refs/heads/develop"]);
    const local = await gitExec(repo, ["rev-parse", "develop"]);
    expect(remote.stdout.trim()).toBe(local.stdout.trim());
  }, 30_000);

  it("refuses FORGE_FLOW_OP=push on the commit path with FLOW-GUARD-04", async () => {
    const { repo } = await adoptedWithOrigin();
    const commit = await gitExec(repo, ["commit", "--allow-empty", "-m", "x"], {
      FORGE_FLOW_OP: "push",
    });
    expect(commit.exitCode).not.toBe(0);
    expect(commit.stderr).toContain("FLOW-GUARD-04");
  }, 30_000);

  it("exempts a repository carrying forge.generated.yaml at its root", async () => {
    const { repo, origin } = await adoptedWithOrigin();
    // The extract marker at the top level marks a generator-owned repository.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(repo, "forge.generated.yaml"),
      "schema: forge/generated@1\ngenerator: repo-extract\n",
    );
    await gitExec(repo, ["add", "forge.generated.yaml"]);
    await gitExec(repo, ["commit", "-m", "marker"], { FORGE_FLOW_OP: "install" });
    const push = await gitExec(repo, ["push", "origin", "develop:refs/heads/develop"], {
      FORGE_FLOW_OP: "",
    });
    expect(push.exitCode, push.stderr).toBe(0);
    void origin;
  }, 30_000);
});
