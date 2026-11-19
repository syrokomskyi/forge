/*
RFC-1616 round-25 independent adversarial probes — candidate commit
40903588b, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.

Round-25 findings:

  CX-r25-A — the fingerprint had NO pseudo-ref member: `.git/ORIG_HEAD`,
    `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `AUTO_MERGE`,
    `FETCH_HEAD`, `BISECT_HEAD`, `REBASE_HEAD`, `MERGE_MSG`,
    `MERGE_MODE`, `COMMIT_EDITMSG`, and ANY planted file at gitDir root
    resolve as revs (`git rev-parse FOO` reads `.git/FOO`) yet sat
    outside `refs/`/`packed-refs`/`indirection` — a rewrite of a
    pre-existing pseudo-ref drifted nothing, so
    `rev-parse`/`show`/`log`/`reset <name>` served unjudged bytes on
    every channel: plain reads, anchored reads, anchored mutations.

    Fix: `rootFiles` fingerprints every regular file + symlink directly
    under gitDir AND commonDir (absolute-keyed — dirs keep their own
    tree members), `wtRefsDir`/`wtRefsFiles` fingerprints the per-
    worktree `refs/` namespace `--git-path refs` never resolves on
    linked worktrees; every reprove compares both. A pre-capture plant
    is JUDGED baseline state — `rev-parse` answering it is honest
    git behavior; only post-judgment drift is a violation.

  CX-r25-B — `anchoredMutationIgnorable` dropped events+pins by
    BASENAME (`index`, `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, …, `*.lock`)
    ANYWHERE in the watched tree — including under `refs/`, where every
    one of those basenames is a legal branch-name component. A checked-
    out `index` branch made `refs/heads/index` invisible to the armed
    anchored window: a mid-window flip steered `reset -q --`'s HEAD
    resolution — the CX-r24-A class reopened through a name filter.

    Fix: the filter is a resolved-path factory —
    `anchoredMutationIgnorable(fp, op)` ignores exactly the real index
    + `index.lock` (+ `sharedindex.*` at the gitdir roots under
    core.splitIndex) and, for `add` only, the object store. Refs, logs,
    HEAD, pseudo-refs, other locks all stay foreign.

  CX-r25-C — under anchored ops `objects/` was event-ignored, existing
    objects were pinned ONLY for `args[0]==="reset"`, and anchored
    calls skip the post-drain fingerprint compare — a mid-window
    rewrite of an existing loose object under an anchored read
    (`verifierGit` + `{preflight}` with `show`/`cat-file`/`log`/
    `rev-parse` argv) served forged bytes with zero detection.

    Fix: pinObjects is `args[0] !== "add"` — every anchored op that
    RESOLVES objects (reset + all anchored reads) pins them; `add`
    alone stays unpinned (never resolves; its own freshen would
    false-trip). `add`'s ignored object-store residual is closed by
    `scanLooseObjects` content-rehashing at the NEXT preflight — a
    forged plant can never become a clean baseline.

  CX-r25-D — `createOriginGit` spawned through `spawnCaptured` with NO
    window watch and no post-drain reprove: only the cached-preflight
    sync reprove before each spawn. A ref flip landing inside the
    judged child's own lifetime (up to the 60s `--batch` envelope) was
    invisible — the whole CX-r22 class rode again on `run`, `runExit`,
    `showMany`, `showManyBytes`.

    Fix: `spawnWatched` wraps every origin spawn — arm the window watch,
    drain after close, full fingerprint reprove. Any event, arm
    failure, or drift degrades to `null` — unreadable → `unresolved`
    → self-tier, never a forged answer.

  CX-r25-E — `verifierScratchGit` passed `useIndexEnv=false`, so the
    arm block and the post-drain guard were BOTH skipped: the judged
    child's whole lifetime was unwatched. Verified airtight on the
    vulnerable build: a /proc-scanned in-child-lifetime flip of
    `refs/heads/index` served FORGED 5/5 while `verifierGit` refused
    5/5.

    Fix: `effectiveIndexEnv = useIndexEnv || isVerifierGitQuery(args)` —
    scratch READ-table ops get the full claims-index + arm + drain
    path (a torn replay view is the same forgery class); the bounded
    scratch MUTATION ops keep ambient real-index semantics their own
    write surface requires.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  anchoredMutationIgnorable,
  armEvidenceWindowWatch,
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  verifierGit,
  verifierScratchGit,
} from "../../../src/utils/verifier-git.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = (branch = "main") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx25-"));
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
 * Ping-pong attacker: RENAME_EXCHANGE swaps `a` ↔ `b` at max rate for
 * `secs`, so whichever inode is sampled mid-window is ~50/50 — a flip
 * lands inside any millisecond-scale gap without precise timing.
 */
const startSwapper = (a: string, b: string, secs = 30) => {
  const child = spawn(
    "python3",
    [
      "-c",
      "import ctypes,sys,time\n" +
        "libc=ctypes.CDLL('libc.so.6',use_errno=True)\n" +
        "a,b,end=sys.argv[1],sys.argv[2],time.time()+float(sys.argv[3])\n" +
        "while time.time()<end:\n" +
        " libc.renameat2(-100,a.encode(),-100,b.encode(),2)\n",
      a,
      b,
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

/**
 * Airtight in-window attacker: scan `/proc` for a DIRECT child of this
 * process whose cmdline contains `needle` (the judged op), then run
 * `act` while the judged child provably exists — the write lands inside
 * `[spawn, exit] ⊆ [arm, settle]`, so fp is provably honest (captured
 * before the child existed) and only a live window watch can refuse.
 */
const whenJudgedChildAlive = (needle: string, act: () => void) => {
  const poll = () => {
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (Number(stat.slice(close + 2).split(" ")[1]) !== process.pid) continue;
        if (readFileSync(`/proc/${d}/cmdline`, "utf8").includes(needle)) {
          act();
          return;
        }
      } catch {
        /* process exited between readdir and read */
      }
    }
    setTimeout(poll, 0);
  };
  setTimeout(poll, 0);
};

/** Many `refs/heads/pad*` loose refs so the child's ref scan is long. */
const padRefs = (root: string, n: number) => {
  const h = git(root, ["rev-parse", "HEAD"]);
  for (let i = 0; i < n; i++)
    writeFileSync(
      path.join(root, ".git", "refs", "heads", `pad${String(i).padStart(5, "0")}`),
      `${h}\n`,
    );
};

describe("CX-r25-A pseudo-refs resolve outside the judged surface", () => {
  it("a baseline .git/ORIG_HEAD plant is judged state — answered or refused, never drifted", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${foreign}\n`);
    // The preflight fingerprints the planted file as baseline repo
    // state — `rev-parse ORIG_HEAD` answering it is honest git
    // semantics (an ORIG_HEAD IS a rev). The hole was post-judgment
    // rewrites drifting unjudged, covered by the next probes.
    const r = await verifierGit(root, ["rev-parse", "ORIG_HEAD"]);
    expect(r.exitCode === -1 || r.stdout.trim() === foreign).toBe(true);
  });
  it("a pre-existing pseudo-ref rewrite after the caller preflight refuses", async () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "HEAD"]);
    const foreign = foreignTip(root);
    writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${honest}\n`);
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "ORIG_HEAD"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
  });
  it("a pseudo-ref rewrite after the caller preflight refuses the anchored reset", async () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "HEAD"]);
    const foreign = foreignTip(root);
    writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${honest}\n`);
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${foreign}\n`);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "ORIG_HEAD", "--", "f.txt"], {
      preflight: pre!,
    });
    expect(r.exitCode).toBe(-1);
  });
  it("an arbitrary planted root file after the caller preflight refuses (.git/FOO)", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    writeFileSync(path.join(root, ".git", "FOO"), `${git(root, ["rev-parse", "HEAD"])}\n`);
    const r = await verifierGit(root, ["rev-parse", "FOO"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
  });
  it("a linked-worktree pseudo-ref rewrite refuses (per-worktree rootFiles)", async () => {
    const root = mkRepo();
    const wt = mkdtempSync(path.join(os.tmpdir(), "cx25-wt-"));
    tmpdirs.push(wt);
    git(root, ["worktree", "add", "-q", wt]);
    // Worktree metadata lives at `<main>/.git/worktrees/<id>` — its
    // root files (ORIG_HEAD et al.) sit outside the COMMON gitdir.
    const wtGitDir = git(wt, ["rev-parse", "--git-dir"]);
    const honest = git(wt, ["rev-parse", "HEAD"]);
    const foreign = foreignTip(wt);
    writeFileSync(path.join(wtGitDir, "ORIG_HEAD"), `${honest}\n`);
    const pre = await evidenceRepoPreflight(wt);
    expect(pre).not.toBeNull();
    writeFileSync(path.join(wtGitDir, "ORIG_HEAD"), `${foreign}\n`);
    const r = await verifierGit(wt, ["rev-parse", "ORIG_HEAD"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
  });
  it("a linked-worktree refs/worktree/ flip refuses (per-worktree refs tree)", async () => {
    const root = mkRepo();
    const wt = mkdtempSync(path.join(os.tmpdir(), "cx25-wt-"));
    tmpdirs.push(wt);
    git(root, ["worktree", "add", "-q", wt]);
    const wtGitDir = git(wt, ["rev-parse", "--git-dir"]);
    const wtRef = path.join(wtGitDir, "refs", "worktree", "probe");
    mkdirSync(path.dirname(wtRef), { recursive: true });
    writeFileSync(wtRef, `${git(wt, ["rev-parse", "HEAD"])}\n`);
    const pre = await evidenceRepoPreflight(wt);
    expect(pre).not.toBeNull();
    writeFileSync(wtRef, `${foreignTip(wt)}\n`);
    const r = await verifierGit(wt, ["rev-parse", "refs/worktree/probe"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
  });
});

describe("CX-r25-B refs/<ignored-basename> mid-window flip", () => {
  it("an armed anchored window records a refs/heads/index write", async () => {
    const root = mkRepo("index");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    // The exact `reset` callsite shape: resolved-path ignore factory +
    // pinObjects (a `show`-class arm would use the same factory shape).
    const watch = armEvidenceWindowWatch(
      root,
      pre!,
      anchoredMutationIgnorable(pre!.fingerprint, "reset"),
      undefined,
      true,
    );
    expect(watch).not.toBeNull();
    const foreign = git(root, ["commit-tree", git(root, ["rev-parse", "HEAD^{tree}"]), "-m", "x"]);
    writeFileSync(path.join(root, ".git", "refs", "heads", "index"), `${foreign}\n`);
    const events = await watch!.settle();
    expect(events.some((e) => e.includes("refs"))).toBe(true);
  });
  it("an in-child-lifetime refs/heads/index flip never steers the anchored reset", async () => {
    const root = mkRepo("index");
    const foreign = foreignTip(root);
    const honestBlob = git(root, ["rev-parse", "index:f.txt"]);
    const forgedBlob = git(root, ["rev-parse", `${foreign}:f.txt`]);
    const ref = path.join(root, ".git", "refs", "heads", "index");
    let forged = 0;
    for (let t = 0; t < 8 && forged === 0; t++) {
      git(root, ["update-ref", "refs/heads/index", "HEAD"]);
      const pre = await evidenceRepoPreflight(root);
      if (pre === null) continue;
      let stop = false;
      const flipper = () => {
        if (stop) return;
        try {
          writeFileSync(ref, `${foreign}\n`);
        } catch {
          /* gone */
        }
        setTimeout(flipper, 0);
      };
      setTimeout(flipper, 0);
      const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "f.txt"], {
        preflight: pre,
      });
      stop = true;
      git(root, ["update-ref", "refs/heads/index", "HEAD"]);
      if (r.exitCode === -1) continue;
      const staged = git(root, ["ls-files", "-s", "f.txt"]);
      if (staged.includes(forgedBlob)) forged++;
      else expect(staged.includes(honestBlob)).toBe(true);
    }
    expect(forged).toBe(0);
  });
});

describe("CX-r25-C objects/ coverage under anchored ops", () => {
  it("an armed anchored read window records an existing-object rewrite", async () => {
    const root = mkRepo();
    const blob = git(root, ["rev-parse", "HEAD:f.txt"]);
    const obj = path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    // The exact anchored-read callsite shape for a non-`add` op:
    // resolved-path ignore + pinObjects=true (CX-r25-C fix).
    const watch = armEvidenceWindowWatch(
      root,
      pre!,
      anchoredMutationIgnorable(pre!.fingerprint, "show"),
      undefined,
      true,
    );
    expect(watch).not.toBeNull();
    chmodSync(obj, 0o644);
    writeFileSync(obj, Buffer.alloc(statSync(obj).size, 0x41));
    const events = await watch!.settle();
    expect(events.some((e) => e === obj)).toBe(true);
  });
  it(
    "a mid-window loose-object ping-pong never steers an anchored show",
    { timeout: 180_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const blob = git(root, ["rev-parse", "HEAD:f.txt"]);
      const obj = path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
      // A valid forged loose object (inflates to attacker content).
      const forged = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
        input: "FORGED\n",
        encoding: "utf8",
      }).trim();
      mkdirSync(path.join(root, ".git", "forge"), { recursive: true });
      const parked = path.join(root, ".git", "forge", "parkedobj");
      copyFileSync(path.join(root, ".git", "objects", forged.slice(0, 2), forged.slice(2)), parked);
      const pre = await evidenceRepoPreflight(root);
      expect(pre).not.toBeNull();
      const swap = startSwapper(obj, parked);
      let forgedAccepted = 0;
      try {
        for (let i = 0; i < 120 && forgedAccepted === 0; i++) {
          const r = await verifierGit(root, ["show", "HEAD:f.txt"], { preflight: pre });
          if (r.exitCode === 0 && r.stdout === "FORGED\n") forgedAccepted++;
        }
      } finally {
        swap.stop();
      }
      expect(forgedAccepted).toBe(0);
    },
  );
  it("a forged loose object planted on add's ignored surface is refused at the next read", async () => {
    const root = mkRepo();
    // Real zlib bytes under a WRONG sha name — inflates, mismatches.
    const forged = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "FORGED\n",
      encoding: "utf8",
    }).trim();
    const blob = git(root, ["rev-parse", "HEAD:f.txt"]);
    const victim = path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    // `add` ignores `objects/` — its own write surface — so a swap
    // inside its window is the accepted residual; the NEXT preflight's
    // loose-object rehash must refuse the plant (never a baseline).
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    writeFileSync(path.join(root, "f.txt"), "v2\n");
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "f.txt"], {
      preflight: pre!,
    });
    expect(r.exitCode).toBe(0);
    chmodSync(victim, 0o644);
    copyFileSync(path.join(root, ".git", "objects", forged.slice(0, 2), forged.slice(2)), victim);
    const next = await verifierGit(root, ["show", "HEAD:f.txt"]);
    expect(next.exitCode).toBe(-1);
  });
});

describe("CX-r25-D OriginGit rides the spawn-window watch", () => {
  it("an in-child ref flip refuses a judged origin.run read", async () => {
    const root = mkRepo("index");
    padRefs(root, 3000);
    const honest = git(root, ["rev-parse", "index"]);
    const foreign = git(root, ["commit-tree", git(root, ["rev-parse", "HEAD^{tree}"]), "-m", "x"]);
    const origin = createOriginGit(root);
    const prime = await origin.run(["rev-parse", "index"]);
    expect(prime?.trim()).toBe(honest);
    const ref = path.join(root, ".git", "refs", "heads", "index");
    const pending = origin.run([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/",
    ]);
    whenJudgedChildAlive("for-each-ref", () => writeFileSync(ref, `${foreign}\n`));
    const r = await pending;
    const line = r?.split("\n").find((l) => l.startsWith("refs/heads/index"));
    expect(r === null || line?.endsWith(honest) === true).toBe(true);
  });
  it("a mid-stream ref flip refuses a long-lived cat-file --batch child", async () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "HEAD"]);
    const foreign = foreignTip(root);
    const origin = createOriginGit(root);
    const prime = await origin.run(["rev-parse", "HEAD"]);
    expect(prime?.trim()).toBe(honest);
    const ref = path.join(root, ".git", "refs", "heads", "main");
    // Long-lived child: thousands of HEAD specs, each re-resolved.
    const specs = Array.from({ length: 4000 }, () => "HEAD");
    const pending = origin.showMany!(specs);
    whenJudgedChildAlive("cat-file", () => writeFileSync(ref, `${foreign}\n`));
    const res = await pending;
    // Contract: null (refused) or every spec answered the SAME honest
    // name — distinct commits in the stream would mean the child
    // resolved drifted state mid-window.
    const answers = new Set((res ?? []).map((b) => (b === null ? "null" : b.slice(0, 80))));
    expect(res === null || (res.every((b) => b !== null) && answers.size === 1)).toBe(true);
  });
});

describe("CX-r25-E verifierScratchGit rides the spawn-window watch", () => {
  it("an in-child-lifetime ref rewrite refuses a judged for-each-ref", async () => {
    const root = mkRepo("index");
    padRefs(root, 3000);
    const honest = git(root, ["rev-parse", "index"]);
    const foreign = git(root, ["commit-tree", git(root, ["rev-parse", "HEAD^{tree}"]), "-m", "x"]);
    const ref = path.join(root, ".git", "refs", "heads", "index");
    const pending = verifierScratchGit(root, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/",
    ]);
    whenJudgedChildAlive("for-each-ref", () => writeFileSync(ref, `${foreign}\n`));
    const r = await pending;
    const line = r.stdout.split("\n").find((l) => l.startsWith("refs/heads/index"));
    expect(r.exitCode === -1 || line?.endsWith(honest)).toBe(true);
  });
});
