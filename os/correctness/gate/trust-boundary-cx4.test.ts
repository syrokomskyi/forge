/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-4 verification of the external
verification trust boundary against export candidate 8f52a73f. Every probe
FAILS when the counterexample is live and PASSES when closed; numbering
continues from CX-60 (round 3 reported CX-46..CX-60).

Round-4 attack surfaces:
  - repo-local git state the "trusted" evidence channel still believes:
    `remote.origin.fetch` refspec rewrites, `url.insteadOf`/`pushurl` splits
    in .git/config (the CX-50 fix scrubbed env config only), and fabricated
    `refs/remotes/origin/*` the fetch never overwrites.
  - repo-config parser levers that blind git's OWN %(trailers) parser while
    the gate's pure-text parser still sees them (trailer.separators,
    core.commentChar) — arbiter asymmetry: exempt + ship unflagged.
  - scaffold adoption verdicts a session can satisfy with CI that can never
    fail (|| true / if:false / branch-filtered triggers) and CODEOWNERS
    patterns picomatch honors but GitHub does not (`?` wildcards).
  - the static scan's dynamic-argv tail on gitEvidence — exempt callsites
    whose tail flags are never judged, with NO runtime predicate behind them
    (the read-only io adapter only re-judges git(), not the execFile channel).
  - preload/redirect env vars that survive verifierGitEnv into the trusted
    git subprocess (LD_PRELOAD and friends — the summary claimed them
    stripped; the code strips only GIT_* plus PATH).
</purpose>
<non-goals>
  <item>Not a contract source of truth — src/utils/verifier-git.ts, os/flow/**, src/onboarding/trust-boundary.ts own behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1616: round-4 independent verifier probes — remote-tracking ref fabrication, trailer-parser config levers, toothless CI adoption, dynamic-argv scanner tail, LD_PRELOAD into the trusted channel.</item>
  <item>RFC-1616: port RFC-1616 round-4 independent verifier probes

Port the clean-context verifier's 14-probe suite as
trust-boundary-cx4.test.ts - premise asserts updated to the hardened
contract - and persist its acceptance report (verdict: refuted,
isolation: subagent). All 11 live counterexamples were closed in
233457a77. Also adds evidence-allowlist-parity.test.ts covering the
gitEvidence runtime allowlist's parity with READ_ONLY_GIT_QUERIES.</item>
  <item>RFC-1616: close RFC-1616 r7 trust-boundary counterexamples

Independent clean-context verification (round 7, candidate d2f270ad6)
returned REFUTED with eleven live counterexamples against the
r6-hardened evidence channel — this commit closes all nine root causes.

- remote.<name>.fetch is value-judged: only the clone-default
  +?refs/heads/*:refs/remotes/<name>/* shape stays KEEP, because git
  UNIONs configured refspecs with the pinned fetch argv and a session
  spec writes arbitrary local refs inside the trusted fetch (CX-94).
  remote.<name>.tagopt|promirror|followremotehead|prunetags|
  skipfetchall|mirror move to REFUSE for the same reason.
- Alternates/shape comment lexing is col-0 `#` only — git's parser does
  not treat whitespace-led `#` as a comment, so `   # forged` is a real
  alternates path the shape check must count (CX-95).
- config reads forbid the alternate-source selectors --file/-f, --blob,
  --worktree (reaches config.worktree even under the disabled-extension
  pin), --system/--global, --default and --includes, plus the
  write-action spellings, on both the evidence and shared read-only
  tables (CX-96).
- verifierGit judges fabrication argv on the runner/policy channel:
  @{...}, -g, --reflog, --walk-reflogs and --fork-point return
  EVIDENCE-REFUSED before the spawn — policy.digest --base 'HEAD@{0}'
  can no longer verify an unattested advance (CX-97).
- --use-bitmap-index/--test-bitmap are forbidden on rev-list/log in
  both tables — the flag opts the trusted walk into the session-
  writable pack bitmap cache the commitGraph/MIDX pins closed (CX-98).
- for-each-ref/show-ref/ls-remote forbid --stdin and --exclude-existing
  on both tables — they block on input the no-stdin spawn never
  supplies (CX-101).
- The workflow-adoption heredoc lexer is bash-faithful: openers are
  scanned on the raw line before the # comment strip (quoted-#
  delimiters, CX-99a), bare delimiters accept digits/./- (CX-99b), and
  the terminator match is strict — << wants the delimiter alone, <<-/
  <<~ skip leading tabs only (CX-100).
- Trailer scans read %e beside %(trailers): a commit declaring a
  non-UTF-8 encoding header recodes every trusted message read, so the
  digest trail and the push-time scan flag it as unverifiable and the
  policy attestation scan skips it (CX-102).

Probe premise updates for the tightened contract: CX-61's decoy
remote.origin.fetch (cx4 and cx5 R5-R1) now asserts the wholesale
EVIDENCE-REFUSED plus FLOW-PUSH-13 refuse — strictly stronger than the
decoy-namespace guard it replaces. The independent r7 probe file and
acceptance report land in the follow-up port commit.</item>
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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { scaffoldTrustBoundary } from "../../../src/onboarding/trust-boundary.ts";
import { setVerifierGitBinForTests, verifierGitEnv } from "../../../src/utils/verifier-git.ts";
import { collectDigest } from "../../flow/digest.ts";
import { gitEvidence } from "../../flow/git.ts";
import { pushFlow } from "../../flow/handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin } from "../../flow/tests/helpers.ts";
import { createSourceScanner } from "@warpgogol/werkstatt-shared/node/kernel-source-scan";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setVerifierGitBinForTests(undefined);
});

/**
 * Host hygiene — the outer session PATH may carry git guard wrappers; strip
 * any dir that ships a git-wrapper.sh so `git` in probes is the real binary.
 */
const CLEAN_PATH = (process.env["PATH"] ?? "")
  .split(path.delimiter)
  .filter((d) => d.length > 0 && !existsSync(path.join(d, "git-wrapper.sh")))
  .join(path.delimiter);
beforeAll(() => {
  process.env["PATH"] = CLEAN_PATH;
});

const gitIn = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Commit a file carrying one verifier trailer pair, return its sha. */
async function trailerCommit(repo: string, file: string, trailerLine: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repo, file), "x\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", `session work\n\n${trailerLine}`]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

/** A plain (trailer-free) commit on top of HEAD, return its sha. */
async function cleanCommit(repo: string, file: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repo, file), "y\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", "clean follow-up"]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

const pushed08 = (data: { pushed: boolean; diagnostics: { ruleId: string }[] }) =>
  data.pushed === false || data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-08");

// ===========================================================================
// A. trusted remote-tracking refs are session-mutable repo state
// ===========================================================================

describe("RFC-1616 r4 — remote-tracking ref trust (fetch-side levers)", () => {
  it(
    "CX-61: `remote.origin.fetch` refspec rewrite — fetch succeeds but refreshes only a decoy namespace; a fabricated refs/remotes/origin/develop survives --prune and becomes the push-scan base — the X-Verifier-Report commit ships unflagged and the real origin receives it",
    { timeout: 120_000 },
    async () => {
      const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx4-refspec-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      const cSha = await cleanCommit(repo, "clean.txt");
      // The session points the remote-tracking ref AT the trailer commit —
      // the scan range then starts after it.
      await gitExec(repo, ["update-ref", "refs/remotes/origin/develop", tSha]);
      // fetch --prune must never touch refs/remotes/origin/develop again:
      // redirect the whole fetch refspec to a sibling namespace.
      await gitExec(repo, [
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/decoy/*",
      ]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      // CX-94 (r7) tightened this: a `remote.origin.fetch` value outside
      // the clone-default heads→own-tracking shape refuses the whole
      // evidence channel — the decoy never even gets to union with the
      // pinned fetch. The fabricated tracking ref below is moot.
      expect(digest.fetched).toBe(false);
      expect(digest.digestId.startsWith("refused-")).toBe(true);
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(data.pushed).toBe(false);
      expect(
        data.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-13"),
        `pushFlow did not refuse on the refused evidence channel ` +
          `(pushed=${data.pushed}, diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
      // corroboration — the trailer commit must never reach the real origin:
      const remoteLog = gitIn(origin, ["rev-list", "develop"]);
      expect(
        remoteLog.includes(tSha),
        `the forged trailer commit reached origin — remote develop contains ${tSha.slice(0, 12)}`,
      ).toBe(false);
      void cSha;
    },
  );

  it(
    "CX-62: `url.<fake>.insteadOf` + `remote.origin.pushurl` in .git/config — the trusted fetch pulls the fake repo's refs (CX-50 fixed env config only) while the session push still lands on the real origin",
    { timeout: 120_000 },
    async () => {
      const { repo, origin, originUrl } = await initRepoWithOrigin(dirs, {
        prefix: "cx4-insteadof-",
      });
      const parent = path.dirname(repo);
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      // A fake "origin" whose develop sits exactly at the trailer commit.
      const fake = path.join(parent, "fake.git");
      gitIn(parent, ["init", "--bare", "-b", "develop", "fake.git"]);
      await gitExec(repo, ["push", fake, "develop", "main"]);
      const cSha = await cleanCommit(repo, "clean.txt");
      // `url.*.insteadOf` is refuse-on-presence: the session-servable
      // rewrite target cannot be distinguished from a real remote, so the
      // channel refuses before any transport is contacted (CX-131).
      await gitExec(repo, ["config", `url.${fake}.insteadOf`, originUrl]);
      await gitExec(repo, ["config", "remote.origin.pushurl", originUrl]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      expect(digest.fetched).toBe(false);
      // The fake remote's tip never entered the digest's remote view —
      // a refused transport contributes nothing, not even a partial tip.
      expect(digest.develop.remote).not.toBe(tSha);
      expect(
        digest.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-13"),
        `url.insteadOf produced no refused-key diagnostic ` +
          `(diagnostics=${JSON.stringify(digest.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(
        data.pushed === false,
        `pushFlow shipped a verifier-trailer commit over a refused remote surface ` +
          `(pushed=${data.pushed}, diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
      const remoteLog = gitIn(origin, ["rev-list", "develop"]);
      expect(
        remoteLog.includes(tSha),
        `the trailer commit reached the real origin — remote develop contains ${tSha.slice(0, 12)}`,
      ).toBe(false);
      void cSha;
    },
  );

  it(
    "CX-63: dead url + pushurl split — the fetch fails honestly (fetched:false) yet pushFlow drops the stale-ref warning from its own diagnostics and still ships on a fabricated remote-tracking ref",
    { timeout: 120_000 },
    async () => {
      const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx4-deadurl-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      await cleanCommit(repo, "clean.txt");
      await gitExec(repo, ["update-ref", "refs/remotes/origin/develop", tSha]);
      await gitExec(repo, ["config", "remote.origin.url", "/nonexistent/dead-r4.git"]);
      await gitExec(repo, ["config", "remote.origin.pushurl", origin]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      expect(digest.fetched).toBe(false);
      expect(digest.diagnostics.some((d) => d.ruleId === "FLOW-DIGEST-01")).toBe(true);
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(
        data.pushed === false ||
          data.diagnostics.some(
            (d) => d.ruleId === "FLOW-PUSH-08" || d.ruleId === "FLOW-DIGEST-01",
          ),
        `pushFlow shipped on a fabricated remote-tracking ref after a FAILED fetch — ` +
          `pushed=${data.pushed} fetched=${String(data.fetched)} ` +
          `diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))}`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// B. repo-config levers that blind git's %(trailers) parser
// ===========================================================================

describe("RFC-1616 r4 — repo-config trailer-parser levers", () => {
  it(
    "CX-64: `core.commentChar X` makes every X-* trailer a comment for %(trailers) — the push scan is blind while the gate's %B parser still exempts the same commit (arbiter asymmetry: exempt AND ship unflagged)",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx4-cchar-" });
      await gitExec(repo, ["config", "core.commentChar", "X"]);
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      // asymmetry evidence: git's trailer parser is blind…
      const trailers = await gitEvidence(repo, ["log", "-1", "--format=%(trailers:only)", tSha]);
      expect(trailers.exitCode).toBe(0);
      // the evidence channel pins core.commentChar — repo config cannot
      // blind git's own trailer parser:
      expect(
        trailers.stdout,
        "core.commentChar still blinds %(trailers) — the evidence channel does not pin trailer-format config",
      ).toContain("X-Verifier-Report");
      // …while the gate's raw-body parser still sees the trailer text:
      const body = await gitEvidence(repo, ["log", "-1", "--format=%B", tSha]);
      expect(body.stdout).toContain("X-Verifier-Report: r.yaml");
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(
        pushed08(data),
        `a verifier-trailer commit shipped under core.commentChar blindness ` +
          `(pushed=${data.pushed}, diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
    },
  );

  it(
    "CX-65: `trailer.separators =` — ':' is no longer a trailer separator for %(trailers) — the X-Verifier-Report commit ships unflagged",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx4-sep-" });
      await gitExec(repo, ["config", "trailer.separators", "="]);
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      const trailers = await gitEvidence(repo, ["log", "-1", "--format=%(trailers:only)", tSha]);
      expect(
        trailers.stdout,
        "trailer.separators still blinds %(trailers) — the evidence channel does not pin trailer-format config",
      ).toContain("X-Verifier-Report");
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(
        pushed08(data),
        `a verifier-trailer commit shipped under trailer.separators blindness ` +
          `(pushed=${data.pushed}, diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// C. scaffold adoption — adopted artifacts that enforce nothing
// ===========================================================================

describe("RFC-1616 r4 — scaffold adoption verdicts (CI that cannot fail)", () => {
  const plant = (rel: string, body: string): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cx4-scaffold-"));
    dirs.push(root);
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
    return root;
  };

  const WORKFLOW_STEPS = `      - run: forge correctness.gate --policy-only --base HEAD~1
      - run: forge policy.digest --verify
      - run: forge pinned.validate --mode ci
`;

  it(
    "CX-66: a workflow whose gate steps end `|| true` counts as adopted — the scaffold keeps a CI job that can never fail, so the external boundary never lands",
    { timeout: 60_000 },
    () => {
      const rel = ".github/workflows/forge-policy.yml";
      const root = plant(
        rel,
        `name: forge-policy
on: [push, pull_request]
jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
      - run: forge correctness.gate --policy-only --base HEAD~1 || true
      - run: forge policy.digest --verify || true
      - run: forge pinned.validate --mode ci || true
`,
      );
      const out = scaffoldTrustBoundary(root, "@operator");
      expect(
        out.skipped.some((s) => s.includes(rel)) === false,
        "the scaffold adopted a workflow whose policy steps can never fail — `|| true` on every run line",
      ).toBe(true);
    },
  );

  it(
    "CX-67: `on.push.branches: [never-lands]` counts the `push` trigger while the job never fires on a real push — adopted without enforcement",
    { timeout: 60_000 },
    () => {
      const rel = ".github/workflows/forge-policy.yml";
      const root = plant(
        rel,
        `name: forge-policy
on:
  push:
    branches: [never-lands-r4]
  pull_request:
jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
${WORKFLOW_STEPS}`,
      );
      const out = scaffoldTrustBoundary(root, "@operator");
      expect(
        out.skipped.some((s) => s.includes(rel)) === false,
        "the scaffold adopted a workflow whose push trigger names a branch no push will ever use",
      ).toBe(true);
    },
  );

  it(
    "CX-68: a step `if: false` still contributes its `run:` line to adoption — adopted while the policy commands never execute",
    { timeout: 60_000 },
    () => {
      const rel = ".github/workflows/forge-policy.yml";
      const root = plant(
        rel,
        `name: forge-policy
on: [push, pull_request]
jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
      - if: false
        run: forge correctness.gate --policy-only --base HEAD~1
      - if: false
        run: forge policy.digest --verify
      - if: false
        run: forge pinned.validate --mode ci
`,
      );
      const out = scaffoldTrustBoundary(root, "@operator");
      expect(
        out.skipped.some((s) => s.includes(rel)) === false,
        "the scaffold adopted a workflow whose every policy step is `if: false`",
      ).toBe(true);
    },
  );

  it(
    "CX-69: CODEOWNERS `?`-wildcard patterns — picomatch matches them, GitHub treats them literally — a configured owner can be 'adopted' while GitHub owns nothing at the trust anchors",
    { timeout: 60_000 },
    () => {
      const rel = ".github/CODEOWNERS";
      const root = plant(
        rel,
        `?orge.yaml @operator
.?orge/ @operator
?ooks/ @operator
.github/?orkflows/ @operator
.github/?ODEOWNERS @operator
`,
      );
      const out = scaffoldTrustBoundary(root, "@operator");
      expect(
        out.skipped.some((s) => s.includes(rel)) === false,
        "the scaffold adopted CODEOWNERS whose patterns only match under picomatch — GitHub owns nothing",
      ).toBe(true);
    },
  );
});

// ===========================================================================
// D. the static scan's dynamic-argv tail on the gitEvidence channel
// ===========================================================================

const FIXTURE_GIT_TS = `import { execFile } from "node:child_process";
export async function git(root: string, io: any, args: string[]): Promise<string> {
  const res = await io.exec("git", ["-C", root, ...args]);
  return res.stdout;
}
export async function gitEvidence(root: string, args: string[]): Promise<string> {
  execFile("git", ["-C", root, ...args], () => {});
  return "";
}
`;

function scanGitEntry(handler: string): boolean | undefined {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx4-scan-"));
  dirs.push(root);
  const put = (rel: string, body: string) => {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  put("forge/os/flow/git.ts", FIXTURE_GIT_TS);
  const file = put("src/commands/ge.ts", handler);
  const scanner = createSourceScanner(root);
  const slices = scanner.handlerSlices(file, "ge.read");
  return slices.find((s) => s.file.endsWith("git.ts"))?.allowlistedGitEntry;
}

describe("RFC-1616 r4 — static scan argv judging on gitEvidence", () => {
  it(
    "CX-70: `gitEvidence(root, ['log', ...flags])` is exempt — a dynamic tail carrying `--ext-diff`/`--output` is never judged, and unlike git() there is NO runtime predicate behind the execFile channel (the 'runtime predicate judges them' comment is false for this body)",
    { timeout: 60_000 },
    () => {
      // literal-tail control: a visible --ext-diff flags the callsite.
      const flagged = scanGitEntry(`import { gitEvidence } from "../../forge/os/flow/git.ts";
export const cmd = {
  name: "ge.read",
  mutatesState: false,
  execute: async (input: any, ctx: any) => {
    await gitEvidence(ctx.workspaceRoot, ["log", "--ext-diff"]);
  },
};
`);
      expect(flagged, "control: literal ['log','--ext-diff'] must flag").toBe(false);

      // the same argv with a dynamic tail is exempt — at runtime
      // flags === ['--ext-diff'] or ['--output=/p'] runs unjudged:
      const dynTail = scanGitEntry(`import { gitEvidence } from "../../forge/os/flow/git.ts";
export const cmd = {
  name: "ge.read",
  mutatesState: false,
  execute: async (input: any, ctx: any) => {
    const flags = ["--ext-diff"];
    await gitEvidence(ctx.workspaceRoot, ["log", ...flags]);
  },
};
`);
      expect(
        dynTail,
        "['log', ...flags] counts as allowlisted — a dynamic tail smuggles " +
          "--ext-diff/--output into the trusted evidence channel unjudged at " +
          "both levels (static exempt; no runtime predicate on execFile)",
      ).toBe(false);
    },
  );
});

// ===========================================================================
// E. preload/redirect env surviving into the trusted git subprocess
// ===========================================================================

describe("RFC-1616 r4 — env scrub completeness on verifierGitEnv", () => {
  const PRELOAD_LEVERS = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "BASH_ENV",
    "ENV",
    "CDPATH",
    "IFS",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "RUBYLIB",
    "PERL5LIB",
    "PERL5OPT",
    "NODE_OPTIONS",
    "NODE_PATH",
    "GCONV_PATH",
    "LOCALDOMAIN",
  ];

  it(
    "CX-71: verifierGitEnv() only strips GIT_* — preload/redirect variables (LD_PRELOAD, LD_*, DYLD_*, BASH_ENV, IFS, NODE_OPTIONS, PYTHONPATH, RUBYLIB, PERL5*) still reach the trusted evidence subprocess; a compiled .so fabricates gitEvidence output",
    { timeout: 120_000 },
    async () => {
      // 1) end-to-end first: a session LD_PRELOAD .so fabricates a trusted
      // read — the decisive evidence, kept soft so the unit lever list still
      // records on failure.
      const cc = ["/usr/bin/cc", "/usr/bin/gcc"].find((b) => existsSync(b));
      if (cc !== undefined) {
        const dir = mkdtempSync(path.join(os.tmpdir(), "cx4-ldpreload-"));
        dirs.push(dir);
        const src = path.join(dir, "pwn.c");
        const so = path.join(dir, "pwn.so");
        writeFileSync(
          src,
          `#include <unistd.h>
#include <stdlib.h>
#include <string.h>
__attribute__((constructor)) static void pwn(void) {
  const char *m = getenv("CX4_FORGE_ME");
  if (m != NULL) { (void)!write(1, m, strlen(m)); _exit(0); }
}
`,
        );
        execFileSync(cc, ["-shared", "-fPIC", "-o", so, src]);
        const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx4-ld-" });
        const realHead = gitIn(repo, ["rev-parse", "HEAD"]).trim();
        const forged = `${"0".repeat(39)}1`;
        const savedLd = process.env["LD_PRELOAD"];
        const savedPayload = process.env["CX4_FORGE_ME"];
        process.env["LD_PRELOAD"] = so;
        process.env["CX4_FORGE_ME"] = `${forged}\n`;
        try {
          const r = await gitEvidence(repo, ["rev-parse", "HEAD"]);
          expect
            .soft(
              r.stdout.trim(),
              "a session LD_PRELOAD fabricated the trusted channel's answer — " +
                `rev-parse returned ${r.stdout.trim().slice(0, 16)}… instead of the real HEAD`,
            )
            .toBe(realHead);
        } finally {
          if (savedLd === undefined) delete process.env["LD_PRELOAD"];
          else process.env["LD_PRELOAD"] = savedLd;
          if (savedPayload === undefined) delete process.env["CX4_FORGE_ME"];
          else process.env["CX4_FORGE_ME"] = savedPayload;
        }
      }

      // 2) unit-level: none of the preload levers may survive the scrub.
      const saved: Record<string, string | undefined> = {};
      for (const k of PRELOAD_LEVERS) {
        saved[k] = process.env[k];
        process.env[k] = "/tmp/cx4-lever";
      }
      let surviving: string[];
      try {
        const env = verifierGitEnv();
        surviving = PRELOAD_LEVERS.filter((k) => env[k] !== undefined);
      } finally {
        for (const k of PRELOAD_LEVERS) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
      expect(
        surviving,
        `session preload/redirect variables survive verifierGitEnv into the trusted git channel: ${surviving.join(",")}`,
      ).toEqual([]);
    },
  );
});

// ===========================================================================
// F. closed-surface re-verification (representative CX-46..60 sample)
// ===========================================================================

describe("RFC-1616 r4 — closed-surface re-verification", () => {
  it(
    "R4-R1: session GIT_* redirection (GIT_DIR, GIT_CONFIG_* url rewrite, GIT_OBJECT_DIRECTORY) cannot steer collectDigest's evidence reads (CX-47/48 class)",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx4-gitenvironment-" });
      const realDev = gitIn(repo, ["rev-parse", "develop"]).trim();
      const realRemote = gitIn(repo, ["rev-parse", "refs/remotes/origin/develop"]).trim();
      const fakeRepo = mkdtempSync(path.join(os.tmpdir(), "cx4-fakerepo-"));
      dirs.push(fakeRepo);
      gitIn(fakeRepo, ["init", "-q"]);
      const saved = {
        GIT_DIR: process.env["GIT_DIR"],
        GIT_WORK_TREE: process.env["GIT_WORK_TREE"],
        GIT_OBJECT_DIRECTORY: process.env["GIT_OBJECT_DIRECTORY"],
        GIT_CONFIG_COUNT: process.env["GIT_CONFIG_COUNT"],
        GIT_CONFIG_KEY_0: process.env["GIT_CONFIG_KEY_0"],
        GIT_CONFIG_VALUE_0: process.env["GIT_CONFIG_VALUE_0"],
      } as const;
      process.env["GIT_DIR"] = path.join(fakeRepo, ".git");
      process.env["GIT_WORK_TREE"] = fakeRepo;
      process.env["GIT_OBJECT_DIRECTORY"] = path.join(fakeRepo, ".git", "objects");
      process.env["GIT_CONFIG_COUNT"] = "1";
      process.env["GIT_CONFIG_KEY_0"] = "url.file:///dev/null.insteadOf";
      process.env["GIT_CONFIG_VALUE_0"] = "file:///";
      try {
        const digest = await collectDigest(repo, ambientIo, { fetch: false });
        expect(digest.develop.local).toBe(realDev);
        expect(digest.develop.remote).toBe(realRemote);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    },
  );

  it(
    "R4-R2: an unreachable resolved git fails CLOSED — the trusted read throws before any digest/push verdict, never an empty or forged answer",
    { timeout: 120_000 },
    async () => {
      const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "cx4-nogit-" });
      const before = gitIn(origin, ["rev-list", "develop"]);
      setVerifierGitBinForTests("/nonexistent/git-r4-9x7");
      // collectDigest rev-parse --git-common-dir fails (exit -1) → the call
      // rejects rather than returning a digest computed on nothing.
      await expect(collectDigest(repo, ambientIo, { fetch: false })).rejects.toThrow();
      await expect(pushFlow(repo, ambientIo, { digest: "dead", dryRun: false })).rejects.toThrow();
      // nothing shipped — the refusal direction held end-to-end.
      expect(gitIn(origin, ["rev-list", "develop"])).toBe(before);
    },
  );

  it(
    "R4-R3: a healthy scaffold adoption control — the real template workflow is adopted (the CX-66..68 probes exercise genuine toothless variants, not a broken detector)",
    { timeout: 60_000 },
    async () => {
      const { FORGE_POLICY_WORKFLOW } = await import("../../../src/onboarding/trust-boundary.ts");
      const root = mkdtempSync(path.join(os.tmpdir(), "cx4-scaffold-ok-"));
      dirs.push(root);
      const rel = ".github/workflows/forge-policy.yml";
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, FORGE_POLICY_WORKFLOW);
      const out = scaffoldTrustBoundary(root, "@operator");
      expect(out.skipped.some((s) => s.includes(rel))).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(FORGE_POLICY_WORKFLOW);
    },
  );
});
