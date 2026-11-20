/*
RFC-1616 round-26 independent adversarial probes — candidate commit
c423e17cc, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.

Round-26 findings:

  CX-r26-A — a NON-REGULAR dirent at a gitdir/commonDir/worktree-gitdir
    ROOT is invisible to every evidence layer: `enumerateTopFiles` and
    `enumerateTreeFiles` record only regular files + symlinks, so a
    FIFO/socket/device leaf is silently skipped; `discoverGitMetaHazards`
    pre-spawn stats only the five named paths plus the `refs/` subtree;
    `fs.watch` sees no open/read/write events on the fifo. Git's dwim
    resolves `$GIT_DIR/<name>` FIRST — before `refs/<name>` — so a
    `.git/<name>` FIFO served by a session-resident feeder shadows a
    real branch, fabricates `FOO`/`MERGE_HEAD`, flips
    `merge-base --is-ancestor`, and steers the anchored `reset`'s rev
    resolution — on every channel.

    Fix: every dirent type is fingerprinted with a `kind` marker;
    `discoverGitMetaHazards` stats EVERY top-level dirent and refuses
    openable non-regular nodes (sockets fail `open()` and stay fine);
    non-regular members anywhere in the enumerated trees mark the
    surface unverifiable → hazards refuse before any judged spawn.

  CX-r26-B — `logs/`, `info/`, `hooks/`, `sequencer/`, and ANY newly
    created gitdir subdir had no fingerprint member while dwim resolves
    `$GIT_DIR/<dir>/<name>` at arbitrary depth — a `logs/FOO` plant
    forged `rev-parse logs/FOO`, and a post-preflight plant survived
    the anchored reprove (no member could describe it).

    Fix: `rootDirs` fingerprints every dir-shaped entry at both roots;
    `nestedFiles` fingerprints every leaf under non-member dirs —
    `logs/`, `info/`, `hooks/`, `forge/`, novel dirs — so a
    post-capture plant/delete/type-swap is drift. The judge also
    refuses files carrying ref-parseable content (`ref:` or bare hex)
    in non-member positions: git writes rev content only at the root,
    `refs/**`, `objects/**`, and the sequencer/rebase/info state-file
    names — a `<sha>` anywhere else is a planted channel even at
    baseline. Embedded gitdirs (`worktrees/<id>`, `modules/<name>`)
    classify the same way one level deeper. `linkDir` presence is a
    violation in every enumerated tree (members beneath a linked dir
    are fingerprint-invisible, CX-145 class).

Attacker primitive (deterministic, no timing guesses): a session-resident
feeder holds a permanent O_RDONLY|O_NONBLOCK fd (keeps the pipe alive so a
blocked open completes on the next writer cycle, never on a dead pipe)
and pulses a writer fd — open O_WRONLY|O_NONBLOCK, write `sha\n`, hold,
close (writers==0 ⇒ the child's next read gets EOF). Every
`open`+`read` window sees exactly one `sha\n` + EOF pair, so reads
complete in bounded ms with the forged payload every cycle.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  verifierGit,
  verifierScratchGit,
} from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = (branch = "main") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx26-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", branch, root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/** A commit the caller never merged — carries a DIFFERENT f.txt blob. */
const foreignTip = (root: string) => {
  writeFileSync(path.join(root, "f.txt"), "FORGED\n");
  git(root, ["add", "f.txt"]);
  const foreign = git(root, ["commit-tree", "-p", "HEAD", "-m", "evil", git(root, ["write-tree"])]);
  execFileSync("git", ["-C", root, "read-tree", "HEAD"], { encoding: "utf8" });
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  return foreign;
};

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/**
 * Session-resident fifo feeder: reader fd keeps the pipe alive; writer
 * pulses deliver `payload` then EOF so the judged child's read-to-EOF
 * completes with attacker bytes on every open window.
 */
const startFifoFeeder = (fifo: string, payload: string, secs = 120) => {
  const child = spawn(
    "python3",
    [
      "-c",
      "import os,sys,time\n" +
        "fifo=sys.argv[1]; data=sys.argv[2].encode(); end=time.time()+float(sys.argv[3])\n" +
        "rfd=os.open(fifo,os.O_RDONLY|os.O_NONBLOCK)\n" +
        "while time.time()<end:\n" +
        "    try:\n" +
        "        wfd=os.open(fifo,os.O_WRONLY|os.O_NONBLOCK)\n" +
        "        os.write(wfd,data)\n" +
        "        time.sleep(0.004)\n" +
        "        os.close(wfd)\n" +
        "        time.sleep(0.002)\n" +
        "    except OSError:\n" +
        "        time.sleep(0.001)\n",
      fifo,
      payload,
      String(secs),
    ],
    { stdio: "ignore" },
  );
  child.unref();
  return {
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* done */
      }
    },
  };
};

const mkfifo = (p: string) => execFileSync("mkfifo", [p]);

describe("CX-r26-A non-regular pseudo-ref at a gitdir root resolves unjudged", () => {
  it(
    "a .git/<branch> fifo shadows refs/heads/<branch> — verifierGit rev-parse answers forged",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const honest = git(root, ["rev-parse", "refs/heads/main"]);
      const foreign = foreignTip(root);
      const fifo = path.join(root, ".git", "main");
      mkfifo(fifo);
      const feeder = startFifoFeeder(fifo, `${foreign}\n`);
      try {
        const r = await verifierGit(root, ["rev-parse", "main"]);
        // Contract: refuse (-1) or answer the real refs/heads/main tip.
        expect(r.exitCode === -1 || r.stdout.trim() === honest).toBe(true);
      } finally {
        feeder.stop();
      }
    },
  );

  it(
    "a .git/<branch> fifo shadows refs/heads/<branch> — verifierGit rev-parse --verify answers forged",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const honest = git(root, ["rev-parse", "refs/heads/main"]);
      const foreign = foreignTip(root);
      const fifo = path.join(root, ".git", "main");
      mkfifo(fifo);
      const feeder = startFifoFeeder(fifo, `${foreign}\n`);
      try {
        const r = await verifierGit(root, ["rev-parse", "--verify", "main"]);
        expect(r.exitCode === -1 || r.stdout.trim() === honest).toBe(true);
      } finally {
        feeder.stop();
      }
    },
  );

  it(
    "a .git/FOO fifo fabricates a rev that does not exist — gitEvidence answers forged",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const foreign = foreignTip(root);
      const fifo = path.join(root, ".git", "FOO");
      mkfifo(fifo);
      const feeder = startFifoFeeder(fifo, `${foreign}\n`);
      try {
        const r = await gitEvidence(root, ["rev-parse", "FOO"]);
        // Honest answer: `FOO` is an unknown revision — nonzero exit.
        expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
      } finally {
        feeder.stop();
      }
    },
  );

  it(
    "a .git/MERGE_HEAD fifo fabricates merge-in-progress — verifierGit rev-parse --verify answers forged",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const foreign = foreignTip(root);
      const fifo = path.join(root, ".git", "MERGE_HEAD");
      mkfifo(fifo);
      const feeder = startFifoFeeder(fifo, `${foreign}\n`);
      try {
        // `rev-parse --verify -q MERGE_HEAD` is the canonical
        // "is a merge in progress" probe — honest answer: nonzero
        // exit (no merge). The fifo makes it answer a sha.
        const r = await verifierGit(root, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
        expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
      } finally {
        feeder.stop();
      }
    },
  );

  it(
    "a .git/<a>/.git/<b> fifo pair steers merge-base --is-ancestor — gitEvidence answers forged",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const foreign = foreignTip(root); // child of HEAD → HEAD IS its ancestor
      const head = git(root, ["rev-parse", "HEAD"]);
      // Real branches so the honest verdict is definite: `anc`(=head) IS
      // an ancestor of `desc`(=foreign) — honest exit 0.
      git(root, ["branch", "anc", head]);
      git(root, ["branch", "desc", foreign]);
      // `.git/<name>` dwim-shadows refs/heads/<name>: feed the pair
      // SWAPPED so `merge-base --is-ancestor anc desc` resolves
      // (foreign,head) and answers 1 (not-ancestor) — the honest 0 flips.
      mkfifo(path.join(root, ".git", "anc"));
      mkfifo(path.join(root, ".git", "desc"));
      const fa = startFifoFeeder(path.join(root, ".git", "anc"), `${foreign}\n`);
      const fb = startFifoFeeder(path.join(root, ".git", "desc"), `${head}\n`);
      try {
        const r = await gitEvidence(root, ["merge-base", "--is-ancestor", "anc", "desc"]);
        expect(r.exitCode === -1 || r.exitCode === 0).toBe(true);
      } finally {
        fa.stop();
        fb.stop();
      }
    },
  );

  it(
    "a .git/<name> fifo steers the anchored reset's rev resolution — foreign blob staged",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const honestBlob = git(root, ["rev-parse", "HEAD:f.txt"]);
      const foreign = foreignTip(root);
      const forgedBlob = git(root, ["rev-parse", `${foreign}:f.txt`]);
      const fifo = path.join(root, ".git", "FOO");
      mkfifo(fifo);
      const pre = await evidenceRepoPreflight(root);
      expect(pre).not.toBeNull();
      const feeder = startFifoFeeder(fifo, `${foreign}\n`);
      try {
        const r = await evidenceAnchoredGit(root, ["reset", "-q", "FOO", "--", "f.txt"], {
          preflight: pre!,
        });
        // Refused (-1) or failed (FOO doesn't exist) are both honest; a 0
        // exit means git resolved `.git/FOO` and staged its tree blob.
        if (r.exitCode === -1 || r.exitCode !== 0) return;
        const staged = git(root, ["ls-files", "-s", "f.txt"]);
        expect(staged.includes(forgedBlob) === false && staged.includes(honestBlob)).toBe(true);
      } finally {
        feeder.stop();
      }
    },
  );

  it(
    "a .git/<branch> fifo shadows on the scratch read-table channel too",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const honest = git(root, ["rev-parse", "refs/heads/main"]);
      const foreign = foreignTip(root);
      const fifo = path.join(root, ".git", "main");
      mkfifo(fifo);
      const feeder = startFifoFeeder(fifo, `${foreign}\n`);
      try {
        const r = await verifierScratchGit(root, ["rev-parse", "main"]);
        expect(r.exitCode === -1 || r.stdout.trim() === honest).toBe(true);
      } finally {
        feeder.stop();
      }
    },
  );

  it(
    "a .git/<branch> fifo shadows on the origin channel too",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const honest = git(root, ["rev-parse", "refs/heads/main"]);
      const foreign = foreignTip(root);
      const fifo = path.join(root, ".git", "main");
      mkfifo(fifo);
      const feeder = startFifoFeeder(fifo, `${foreign}\n`);
      try {
        const origin = createOriginGit(root);
        const r = await origin.run(["rev-parse", "main"]);
        // null = degraded (honest fail-closed); a forged sha is a live hole.
        expect(r === null || r.trim() === honest).toBe(true);
      } finally {
        feeder.stop();
      }
    },
  );
});

describe("CX-r26-B regular pseudo-ref files under unfingerprinted gitdir subdirs resolve unjudged", () => {
  // `enumerateTreeFiles` fingerprint members exist ONLY for objects/,
  // worktrees/, modules/, refs/ and the per-worktree refs tree — every
  // other gitdir subdir (logs/, info/, hooks/, and ANY new dir) is
  // fingerprint-silent, while git's dwim resolves `$GIT_DIR/<name>` at
  // ANY depth: `.git/logs/FOO` answers `rev-parse logs/FOO`. A
  // mid-window write is event/pin-caught (the dirs ARE watched), but a
  // plant is invisible to the fingerprint — so a post-PREFLIGHT plant
  // against a caller-owned anchor survives the reprove outright: the
  // fingerprint has no member that could describe it.
  it("a .git/logs/FOO plant answers verifierGit rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    writeFileSync(path.join(root, ".git", "logs", "FOO"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "logs/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/info/BAR plant answers gitEvidence rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    writeFileSync(path.join(root, ".git", "info", "BAR"), `${foreign}\n`);
    const r = await gitEvidence(root, ["rev-parse", "info/BAR"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a fresh .git/x/qux dir+file answers verifierGit rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    writeFileSync(path.join(root, ".git", "x", "qux"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "x/qux"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/hooks/BAZ plant answers verifierGit rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    writeFileSync(path.join(root, ".git", "hooks", "BAZ"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "hooks/BAZ"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it(
    "a post-PREFLIGHT .git/logs/FOO plant survives the anchored reprove — a between-operations rewrite the fingerprint cannot see",
    { timeout: 120_000 },
    async () => {
      const root = mkRepo();
      const foreign = foreignTip(root);
      const pre = await evidenceRepoPreflight(root);
      expect(pre).not.toBeNull();
      // The plant lands AFTER the judgment — the CX-r25-A class, just
      // under a directory no fingerprint member covers.
      writeFileSync(path.join(root, ".git", "logs", "FOO"), `${foreign}\n`);
      const r = await verifierGit(root, ["rev-parse", "logs/FOO"], { preflight: pre! });
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    },
  );

  it(
    "a post-PREFLIGHT .git/logs/FOO plant steers the anchored reset — foreign blob staged",
    { timeout: 120_000 },
    async () => {
      const root = mkRepo();
      const honestBlob = git(root, ["rev-parse", "HEAD:f.txt"]);
      const foreign = foreignTip(root);
      const forgedBlob = git(root, ["rev-parse", `${foreign}:f.txt`]);
      const pre = await evidenceRepoPreflight(root);
      expect(pre).not.toBeNull();
      writeFileSync(path.join(root, ".git", "logs", "FOO"), `${foreign}\n`);
      const r = await evidenceAnchoredGit(root, ["reset", "-q", "logs/FOO", "--", "f.txt"], {
        preflight: pre!,
      });
      if (r.exitCode === -1 || r.exitCode !== 0) return;
      const staged = git(root, ["ls-files", "-s", "f.txt"]);
      expect(staged.includes(forgedBlob) === false && staged.includes(honestBlob)).toBe(true);
    },
  );
});
