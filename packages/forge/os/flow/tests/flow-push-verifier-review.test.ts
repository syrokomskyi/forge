/*
<MODULE_CONTRACT>
<purpose>RFC-1616 (AC-6): flow.push verifier-trailer scan — an unpushed
commit carrying X-Expectation-Origin / X-Verifier-Report /
X-Correctness-Weakening / X-Policy-Digest refuses FLOW-PUSH-08 unless the
operator passes --accept-verifier-trailers "<reason>", and the repository
may opt out with push.requireVerifierReview: false (default: required).</purpose>
<non-goals>
  <item>No publication coverage — the scan runs before the extract path.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: initial suite — refuse without flag, push with reason, opt-out honored, default-required.</item>
  <item>RFC-1616: external verification trust boundary

policy.digest (canonical SHA-256 over the frozen surface), adversarial.run
with a 12-scenario catalog replayed through the real gate in a scratch
clone, flow.push verifier-trailer hard stop (fail-closed on unreadable
forge.yaml), project.owner + push.requireVerifierReview config, trust-boundary
scaffold (CODEOWNERS + forge-policy workflow) and reference docs.</item>
  <item>RFC-1616: scaffold templates as shipped files + AC-6 probe name alignment

Extract forge-policy.template.yml and CODEOWNERS.template into
src/scaffold/github/ (shipped in package files[]) so the AC-7/AC-8
file-contains probes verify the real artifacts; rename the push-trailer
suite to the RFC-bound flow-push-verifier-review.test.ts.</item>
  <item>RFC-1616: close RFC-1616 r5 trust-boundary counterexamples</item>
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

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { pushFlow } from "../handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function trailerCommit(repo: string, file: string, trailer: string): Promise<string> {
  await writeFile(join(repo, file), "x\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", `session work\n\n${trailer}: yes`]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

async function plainCommit(repo: string, file: string): Promise<void> {
  await writeFile(join(repo, file), "x\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", `session work`]);
}

describe("flow.push verifier-trailer scan (RFC-1616)", () => {
  it("refuses FLOW-PUSH-08 on an unpushed X-Verifier-Report commit", async () => {
    const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vt-" });
    const sha = await trailerCommit(repo, "work.txt", "X-Verifier-Report");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.pushed).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
    expect(data.diagnostics[0]?.message).toContain(sha.slice(0, 9));
    expect(data.verifierTrailerCommits?.[0]?.trailers).toContain("X-Verifier-Report");
    // nothing left the machine
    expect((await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim()).not.toBe(
      sha,
    );
  }, 60_000);

  it.each(["X-Expectation-Origin", "X-Correctness-Weakening", "X-Policy-Digest"])(
    "flags %s the same way",
    async (trailer) => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vt-" });
      await trailerCommit(repo, `w-${trailer}.txt`, trailer);
      const digest = await collectDigest(repo, ambientIo, { fetch: false });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
      expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
      expect(data.verifierTrailerCommits?.[0]?.trailers).toContain(trailer);
    },
    60_000,
  );

  it("proceeds with --accept-verifier-trailers and records the reason", async () => {
    const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vt-" });
    const sha = await trailerCommit(repo, "work.txt", "X-Expectation-Origin");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, {
      digest: digest.digestId,
      dryRun: false,
      acceptVerifierTrailers: "operator reviewed verifier report r24",
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.pushed).toBe(true);
    expect(data.verifierTrailersAccepted).toBe("operator reviewed verifier report r24");
    expect((await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim()).toBe(sha);
  }, 60_000);

  it("push.requireVerifierReview: false opts the repository out", async () => {
    const { repo, origin, originUrl } = await initRepoWithOrigin(dirs, {
      prefix: "flow-push-vt-",
    });
    await writeFile(
      join(repo, "forge.yaml"),
      `schema: forge/config@1\nproject:\n  name: opt-out\npaths: {}\npush:\n  requireVerifierReview: false\n  expectedRemote: ${JSON.stringify(originUrl)}\n`,
    );
    await gitExec(repo, ["add", "forge.yaml"]);
    await gitExec(repo, ["commit", "-qm", "opt out"]);
    const sha = await trailerCommit(repo, "work.txt", "X-Verifier-Report");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics.filter((d) => d.ruleId === "FLOW-PUSH-08")).toEqual([]);
    expect(data.pushed).toBe(true);
    expect((await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim()).toBe(sha);
  }, 60_000);

  it("push.requireVerifierReview: true (explicit) still requires the flag", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, {
      prefix: "flow-push-vt-",
    });
    await writeFile(
      join(repo, "forge.yaml"),
      `schema: forge/config@1\nproject:\n  name: opted-in\npaths: {}\npush:\n  requireVerifierReview: true\n  expectedRemote: ${JSON.stringify(originUrl)}\n`,
    );
    await gitExec(repo, ["add", "forge.yaml"]);
    await gitExec(repo, ["commit", "-qm", "declare"]);
    await trailerCommit(repo, "work.txt", "X-Verifier-Report");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-08");
  }, 60_000);

  it("a plain session commit pushes without the flag (no trailers)", async () => {
    const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "flow-push-vt-" });
    await plainCommit(repo, "work.txt");
    const localTip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.diagnostics).toEqual([]);
    expect(data.pushed).toBe(true);
    expect(data.verifierTrailerCommits).toEqual([]);
    expect((await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim()).toBe(
      localTip,
    );
  }, 60_000);
});
