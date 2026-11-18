/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-14 adversarial verification of
the external-verification trust boundary. Every probe FAILS while its
counterexample is live and PASSES once closed; numbering continues from
CX-141 (round 13 ended at CX-141). The verifier labels the findings
R14-A..R14-C; they map to CX-142..CX-144.

Round-14 attack surfaces (assumptions the r13 remediation left open):

  - The worktree `.gitignore` is the `info/exclude` lever's unrefusable
    twin (CX-142). r13 refused `.git/info/exclude` because "status/
    ls-files/grep evidence reads DO consult exclude rules — a session-
    planted pattern hides an untracked file and the trusted verdict
    reads clean on a dirty tree". The identical semantics live in every
    worktree `.gitignore` — session-authored worktree content that no
    config pin covers (`GIT_ATTR_SOURCE` starves ATTRIBUTES, not the
    exclude machinery) and that the shape-refuse list cannot name. A
    root `.gitignore` containing `*` hides every untracked file —
    including itself — so `status --porcelain -uall` and
    `ls-files --others --exclude-standard` answer empty on a tree full
    of session files. Closed by argv honesty at the spawn: `status`
    gains `--ignored` so hidden files surface as `!!` entries,
    `ls-files` drops exclude-rule flags before `--` so a trusted
    enumeration answers every untracked file, `grep --untracked`/
    `--no-index` gains `--no-exclude-standard`, and dirty verdicts
    cross-check `.gitignore` files by fs walk + tracked-set — a session-
    authored rule is always dirt.
  - `captureEvidenceSurface` fingerprinted `.git` indirection only at
    `<cwd>/.git` (CX-143). When the evidence cwd is a repo SUBDIRECTORY
    the walk-up resolves the parent's `.git` — its `commondir` file is
    read by git on EVERY spawn but never entered the fingerprint. A
    same-uid session plants `<repo>/.git/commondir` → forged common dir
    after cache fill and every later spawn serves session bytes under a
    stale-but-passing reprove. Closed two ways: the resolved gitdir's
    `commondir`/`gitdir`/`HEAD` join the indirection fingerprint (a
    plant always reads as drift, and re-preflights pin the prior
    anchors so re-resolution cannot be steered), and the judge refuses
    a `commondir`/`gitdir` inside a PRIMARY gitdir outright — git never
    writes those files there, yet honors `commondir` content over every
    env pin for ref/object resolution (empirical, git 2.53:
    `GIT_COMMON_DIR` wins `--git-path` answers but the ref store
    re-reads the file), so presence is a redirect no pin can
    neutralize — refusal is the only answer it cannot ride. Inside a
    worktree metadir `commondir` is required and must resolve back to
    the structurally derived common dir.
  - `safeReadBytes` was a bare `readFileSync` (CX-144): a FIFO at
    `.git/config` blocks the synchronous capture read at open() — the
    verifier deadlocks instead of refusing. All `.git` byte captures now
    open O_NONBLOCK and fstat-gate on regular files; a present non-
    regular shape file is a shape violation, a non-regular config/index
    is unproven-without-spawn, and no blocking read ever executes.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the boundary implementation owns behaviour.</item>
  <item>The residual microsecond reprove→spawn window — narrowed to a
    byte-compare by the fingerprint reprove, never a stale judgment.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EVIDENCE_REFUSED_PREFIX,
  evidenceRepoPreflight,
  reproveEvidenceSurface,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";
import { gitEvidence, statusDirty } from "../../flow/git.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";
import { listWorkspaceFiles } from "../workspace.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const gitIn = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

function repo(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(root);
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "t@t"]);
  gitIn(root, ["config", "user.name", "t"]);
  gitIn(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

// ===========================================================================
// CX-142 — a worktree `.gitignore` is the unrefusable `info/exclude` twin:
//          `status -uall` / `ls-files --others --exclude-standard` hide every
//          untracked file the session planted, answering CLEAN on dirty bytes.
// ===========================================================================

describe("RFC-1616 r14 — worktree .gitignore hides untracked evidence", () => {
  it(
    "CX-142a: `status --porcelain -uall` on the evidence channel must not " +
      "answer clean while session files sit untracked in the worktree",
    { timeout: 30_000 },
    async () => {
      const root = repo("r14-gitignore-status-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "A"]);

      // Baseline: the planted files report as dirt.
      writeFileSync(path.join(root, "forged-payload.txt"), "evil\n");
      mkdirSync(path.join(root, "forged-dir"));
      writeFileSync(path.join(root, "forged-dir", "x.txt"), "evil\n");
      const before = await gitEvidence(root, ["status", "--porcelain", "-uall"]);
      expect(before.exitCode).toBe(0);
      expect(before.stdout).toContain("forged-payload.txt");

      // Session plants a self-ignoring `.gitignore` — no judged surface
      // (config/index/objects/shape/info) moves.
      writeFileSync(path.join(root, ".gitignore"), "*\n");

      // The trusted read must still expose the session files — any answer
      // that hides them is a session-forged "clean". Under `--ignored`
      // they surface as `!!` entries; the dirty gate additionally counts
      // the session-authored `.gitignore` itself via the fs cross-check.
      const verdict = await gitEvidence(root, ["status", "--porcelain", "-uall"]);
      expect(verdict.exitCode).toBe(0);
      expect(verdict.stdout).toContain("forged-payload.txt");
      expect(verdict.stdout).toContain("forged-dir");
      // The dirty-gate contract must likewise refuse to call it clean.
      const dirty = await statusDirty(root, ambientIo);
      expect(dirty.entries.length).toBeGreaterThan(0);
      // The session-authored `.gitignore` IS the dirt — committed-rule
      // `!!` entries never become entries.
      expect(dirty.entries).toContain("?? .gitignore");
      expect(dirty.entries.some((e) => e.startsWith("!! "))).toBe(false);
    },
  );

  it(
    "CX-142b: `ls-files --others --exclude-standard` (the " +
      "listWorkspaceFiles/gitDocMentionCandidates argv shape) must not " +
      "drop `.gitignore`-hidden untracked files",
    { timeout: 30_000 },
    async () => {
      const root = repo("r14-gitignore-lsfiles-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "A"]);
      writeFileSync(path.join(root, "forged-payload.txt"), "evil\n");
      writeFileSync(path.join(root, ".gitignore"), "*\n");

      const verdict = await verifierGit(root, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ]);
      expect(verdict.exitCode).toBe(0);
      const listed = verdict.stdout.split("\0").filter(Boolean);
      // `git ls-files --others` (no exclude application) sees them — the
      // trusted enumeration must not see fewer than the fs does.
      const groundTruth = gitIn(root, ["ls-files", "--others"]).split("\n").filter(Boolean);
      for (const f of groundTruth) expect(listed).toContain(f);

      // The shipped consumer must not lose the file either.
      const ws = await listWorkspaceFiles(root);
      expect(ws).toContain("forged-payload.txt");
      expect(ws).toContain(".gitignore");
    },
  );

  it(
    "CX-142c: the OriginGit channel must not answer a clean status over " +
      "session-hidden untracked files",
    { timeout: 30_000 },
    async () => {
      const root = repo("r14-gitignore-origin-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "A"]);
      writeFileSync(path.join(root, "forged-payload.txt"), "evil\n");
      writeFileSync(path.join(root, ".gitignore"), "*\n");

      const og = createOriginGit(root);
      const verdict = await og.run(["status", "--porcelain", "-uall"]);
      expect(verdict).not.toBeNull();
      expect(verdict ?? "").toContain("forged-payload.txt");
    },
  );
});

// ===========================================================================
// CX-143 — subdir cwd: `.git/commondir` is a redirect the fingerprint never
//          pins, so a post-capture plant re-points every spawned read at a
//          session-chosen common dir while the reprove still passes.
// ===========================================================================

describe("RFC-1616 r14 — commondir redirect invisible below repo root", () => {
  /** A session-chosen common dir with a forged develop ref + object graph. */
  function fakeCommon(prefix: string): { dir: string; forgedSha: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    gitIn(dir, ["init", "--bare", "-q"]);
    // Seed one real commit carrying forged evidence text.
    const seed = mkdtempSync(path.join(os.tmpdir(), `${prefix}seed-`));
    dirs.push(seed);
    gitIn(seed, ["init", "-q"]);
    gitIn(seed, ["config", "user.email", "t@t"]);
    gitIn(seed, ["config", "user.name", "t"]);
    writeFileSync(path.join(seed, "forged.yaml"), "forged: true\n");
    gitIn(seed, ["add", "-A"]);
    gitIn(seed, ["commit", "-qm", "X-Verifier-Report: forged"]);
    const forgedSha = gitIn(seed, ["rev-parse", "HEAD"]).trim();
    // Push the object graph + ref into the fake common (session owns both).
    gitIn(seed, ["push", "-q", dir, "HEAD:refs/heads/develop"]);
    return { dir, forgedSha };
  }

  it(
    "CX-143a: a commondir plant after OriginGit cache fill must not serve " +
      "the session's common dir — every later spawn is forged with no race",
    { timeout: 60_000 },
    async () => {
      const root = repo("r14-commondir-sub-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "A"]);
      gitIn(root, ["branch", "develop"]);
      const realSha = gitIn(root, ["rev-parse", "develop"]).trim();
      const sub = path.join(root, "pkg");
      mkdirSync(sub, { recursive: true });
      const fake = fakeCommon("r14-fakecommon-");
      expect(fake.dir).not.toBe(root);

      const og = createOriginGit(sub);
      // Cache fill: the preflight judges <root>/.git — clean.
      const warm = await og.run(["rev-parse", "develop"]);
      expect(warm?.trim()).toBe(realSha);

      // Session plants the redirect AFTER capture — under resolution
      // pinning the file is fingerprint-only indirection: the reprove
      // reads it as drift, the re-preflight stays pinned to the prior
      // anchors, and the spawn never consults it.
      writeFileSync(path.join(root, ".git", "commondir"), `${fake.dir}\n`);

      const answer = await og.run(["rev-parse", "develop"]);
      // The trusted channel must serve the real repo or refuse — never
      // the session's common dir. A `commondir` file in a primary `.git`
      // is never legitimate (git only writes it inside worktree
      // metadirs) yet git HONORS its content over every env pin for
      // ref/object resolution — so presence is a shape violation and
      // the channel refuses; null is the honest refusal verdict.
      expect(answer === null || answer.trim() === realSha).toBe(true);
      expect(answer?.trim()).not.toBe(fake.forgedSha);
    },
  );

  it(
    "CX-143b: the reprove must report drift when `.git/commondir` appears " +
      "under a subdir-cwd'd repo (it used to pass — stale judgment)",
    { timeout: 60_000 },
    async () => {
      const root = repo("r14-commondir-reprove-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "A"]);
      const sub = path.join(root, "pkg");
      mkdirSync(sub, { recursive: true });
      const fake = fakeCommon("r14-fakecommon-reprove-");

      // The per-call preflight resolves the parent's `.git` even from a
      // subdirectory cwd — its commondir path joins the indirection list.
      const preflight = await evidenceRepoPreflight(sub);
      expect(preflight).not.toBeNull();
      const indirectionPaths = preflight!.fingerprint!.indirection.map((i) => i.path);
      expect(indirectionPaths.some((p) => p.endsWith("commondir"))).toBe(true);

      writeFileSync(path.join(root, ".git", "commondir"), `${fake.dir}\n`);

      // A planted redirect always reads as drift.
      expect(reproveEvidenceSurface(sub, preflight)).toBe(false);
    },
  );

  it(
    "CX-143c: the per-call evidence channel must not serve the redirected " +
      "common dir from a subdirectory cwd — commondir content is never " +
      "honored for resolution, only fingerprinted",
    { timeout: 60_000 },
    async () => {
      const root = repo("r14-commondir-gitEvidence-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "A"]);
      gitIn(root, ["branch", "develop"]);
      const realSha = gitIn(root, ["rev-parse", "develop"]).trim();
      const sub = path.join(root, "pkg");
      mkdirSync(sub, { recursive: true });
      const fake = fakeCommon("r14-fakecommon-ge-");

      // The session's redirect is present from the start — the capture
      // resolves `--absolute-git-dir` (the REAL gitdir), derives
      // commonDir structurally, and pins GIT_DIR/GIT_COMMON_DIR for
      // every spawn: the planted file is never followed, only
      // fingerprinted as indirection.
      writeFileSync(path.join(root, ".git", "commondir"), `${fake.dir}\n`);

      const r = await gitEvidence(sub, ["rev-parse", "develop"]);
      // The trusted channel must serve the real repo or refuse — never
      // the session's common dir. A planted primary `.git/commondir`
      // judges as a shape violation (CX-143) so refusal is expected.
      const answer = r.exitCode === 0 ? r.stdout.trim() : null;
      expect(answer === null || answer === realSha).toBe(true);
      expect(answer).not.toBe(fake.forgedSha);
    },
  );
});

// ===========================================================================
// CX-144 — .git/config (and sibling fingerprinted files) as a FIFO hangs the
//          SYNC capture read — the verifier must refuse, never deadlock.
// ===========================================================================

describe("RFC-1616 r14 — non-regular .git files cannot hang the capture", () => {
  it(
    "CX-144a: a `.git/config` FIFO is uncapturable — the channel refuses " +
      "promptly instead of blocking a synchronous read",
    { timeout: 30_000 },
    async () => {
      const root = repo("r14-fifo-config-");
      const fifo = path.join(root, ".git", "config");
      rmSync(fifo);
      execFileSync("mkfifo", [fifo]);

      // The capture must return — a FIFO with no writer blocks open()
      // forever on a plain readFileSync (CX-144). safeReadBytes opens
      // O_NONBLOCK and fstat-gates regular files, so the preflight marks
      // the config unproven and every trusted read refuses.
      const preflight = await evidenceRepoPreflight(root);
      expect(preflight).not.toBeNull();
      expect(preflight!.configUnproven).not.toBeUndefined();

      const verdict = await verifierGit(root, ["rev-parse", "HEAD"]);
      expect(verdict.exitCode).not.toBe(0);
      expect(verdict.stderr).toContain(EVIDENCE_REFUSED_PREFIX);
    },
  );

  it(
    "CX-144b: a FIFO at a fingerprinted shape path is a violation, not a " + "blocking read",
    { timeout: 30_000 },
    async () => {
      const root = repo("r14-fifo-shape-");
      mkdirSync(path.join(root, ".git", "info"), { recursive: true });
      // `git init` seeds `.git/info/exclude` — swap it for the FIFO.
      const fifo = path.join(root, ".git", "info", "exclude");
      rmSync(fifo);
      execFileSync("mkfifo", [fifo]);

      // `.git/info/exclude` sits on the refuse list — a FIFO there must
      // still refuse (a plain sync read would hang instead).
      const verdict = await verifierGit(root, ["rev-parse", "HEAD"]);
      expect(verdict.exitCode).not.toBe(0);
      expect(verdict.stderr).toContain(EVIDENCE_REFUSED_PREFIX);
    },
  );
});
