/*
RFC-1616 round-32 independent adversarial probes — candidate commit
e32510593, exported tree.

CX-r32-A — `unprovenIgnoredPaths`' HEAD-bound provenance (verifier-git.ts
:5471-5558) chains three trusted children each judging its OWN instant:

  1. `ls-files -z -- "*.gitignore"`        → trackedSet (claims index)
  2. `check-ignore -v -z --stdin`          → cited source per `!!`
  3. `diff --name-only -z HEAD`            → whole-tree dirty set

Each `verifierGit` spawn mints a FRESH preflight — there is no cross-
child HEAD anchor. The `!!` is called proven when the cited source is
tracked AND worktree-clean against HEAD **at the diff child's instant**.
Between (2) and (3) the session owns refs/: moving `refs/heads/main`
onto a commit that carries the worktree's `.gitignore` bytes turns the
same foreign worktree rule into "committed policy" for exactly the diff
child's instant. No single in-window event fires — the write lands in
the inter-child gap where no armed watch exists.

Attack shape:

  t0  HEAD=c1: `.gitignore` committed `x`; index clean. Worktree
      `.gitignore` = `x\nsub/` (foreign rule, ` M` vs c1), `sub/payload`
      planted → `status` honestly reports ` M .gitignore` + `!! sub/payload`.
  t1  unprovenIgnoredPaths(root, ["sub/payload"]):
      - ls-files → trackedSet = {.gitignore}          (HEAD-independent)
      - check-ignore → cites `.gitignore`             (worktree bytes)
      — `refs/heads/main` := c2 (prebuilt commit whose `.gitignore`
         blob IS the worktree bytes; plumbing-only, index untouched) —
      - `diff --name-only -z HEAD` → vs c2: `.gitignore` content-equal
         → NOT dirty → proven → `sub/payload` stays hidden.
  t2  (optional) `refs/heads/main` := c1 restores the judged state.

The `srcStats` ino+ctime pin only covers the WORKTREE `.gitignore` —
never the ref the dirty-set baseline resolves through. extraWatchPaths
pins the source bytes inside each child's window; the HEAD object the
`diff` compares against is outside every pin set.

Honest outcomes counted: refused = null return (EVIDENCE-REFUSED up the
call stack); honest = `sub/payload` present in the unproven set;
forged = returned set lacks `sub/payload` — a `!!` member attested by a
rule no single repository instant committed.

CONFIRMED r32 (forged=30/30 at both levels): the mover fires on the
first git child after the `check-ignore` child exits — inside the diff
call's fresh preflight, before its window arms — and
`diff --name-only -z HEAD` answers clean-vs-c2. `statusDirty` drops the
member identically; restoring c1 afterwards leaves the ` M .gitignore`
dirt line but the `!!` member is already lost from the verdict.

Fix direction: bind the dirty-set baseline to the HEAD resolved at the
FIRST child's instant (e.g. capture `rev-parse HEAD`/`HEAD^{tree}` on
the same claims preflight, then `diff <oid>` rather than the `HEAD`
name), or re-resolve HEAD in the verdict loop and refuse on drift — a
mid-call ref move must read as drift, never as provenance.

Fix: `unprovenIgnoredPaths` no longer chains per-child `verifierGit`
windows. It mints one `evidenceRepoPreflight`, enumerates the claims-
tracked `.gitignore` sources on the byte-pinned claims fd, arms ONE
`armEvidenceWindowWatch` spanning the whole consult (sources pinned as
extraFiles), and runs `check-ignore`/`diff HEAD` as children inside it.
A `refs/heads/main` write anywhere in the consult — before, between,
or after any child — is an armed event or pin drift at settle, so the
verdict either reflects a single stable instant or refuses.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unprovenIgnoredPaths } from "../../../src/utils/verifier-git.ts";
import { statusDirty } from "../../flow/git.ts";
import { ambientIo } from "../../../src/utils/io.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx32a-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, ".gitignore"), "x\n");
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "c1"]);
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "sub", "payload"), "EVIL\n");
  return root;
};

/** Build c2 = HEAD's tree with `.gitignore` replaced by the WORKTREE bytes blob. */
const makeForeignCommit = (root: string): string => {
  const blob = git(root, ["hash-object", "-w", ".gitignore"]);
  const tree = git(root, ["ls-tree", "HEAD"])
    .split("\n")
    .map((l) => (l.endsWith("\t.gitignore") ? `100644 blob ${blob}\t.gitignore` : l))
    .join("\n");
  const newTree = git(root, ["mktree"], tree + "\n");
  return git(root, ["commit-tree", newTree, "-p", "HEAD", "-m", "x"]);
};

/**
 * Watches the verifier's /proc children: after the `check-ignore` child
 * exits, fires `c2` into `refs/heads/main` on the Nth later-spawned child
 * (inside the diff call's fresh preflight — before its window arms; a torn
 * capture re-preflights into the c2 surface either way). Optionally
 * restores `c1` ~`restoreMs` after the `diff` child exits.
 */
const startHeadMover = (root: string, c2: string, opts: { fireOnChild?: number } = {}) => {
  const fireOn = opts.fireOnChild ?? 1;
  const script =
    "import os,sys,time\n" +
    "vpid=int(sys.argv[1]); ref=sys.argv[2]; c2=sys.argv[3]\n" +
    "fireOn=int(sys.argv[4]); end=time.time()+float(sys.argv[5])\n" +
    "me=str(os.getpid()); ciSeen=ciGone=False; fired=False\n" +
    "seenNew=set()\n" +
    "def kids():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
    "            try: out += open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return out\n" +
    "def has(kw,ks):\n" +
    "    for k in ks:\n" +
    "        if k==me: continue\n" +
    "        try: av=open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
    "        except: av=[]\n" +
    "        if kw in av: return True\n" +
    "    return False\n" +
    "while time.time()<end and not fired:\n" +
    "    ks=kids()\n" +
    "    ci=has(b'check-ignore',ks)\n" +
    "    if ci: ciSeen=True\n" +
    "    if ciSeen and not ci: ciGone=True\n" +
    "    if ciGone and not fired:\n" +
    "        for k in ks:\n" +
    "            if k==me or k in seenNew: continue\n" +
    "            try: a0=open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')[0]\n" +
    "            except: a0=b''\n" +
    "            if not (a0.endswith(b'/git') or a0==b'git'): continue\n" +
    "            seenNew.add(k)\n" +
    "        if len(seenNew)>=fireOn:\n" +
    "            try: open(ref,'w').write(c2+'\\n'); fired=True\n" +
    "            except: pass\n" +
    "    time.sleep(0.00002)\n";
  const child = spawn(
    "python3",
    ["-c", script, String(process.pid), `${root}/.git/refs/heads/main`, c2, String(fireOn), "30"],
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

describe("CX-r32-A: HEAD-move between `unprovenIgnoredPaths` children forges `!!` provenance", () => {
  it("control: committed rule → proven (payload stays hidden honestly)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-qm", "c2"]);
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).not.toBeNull();
    expect([...unproven!]).not.toContain("sub/payload");
  });

  it("control: foreign unstaged `.gitignore` → payload IS unproven (r31-A fix)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).not.toBeNull();
    expect([...unproven!]).toContain("sub/payload");
  });

  it(
    "refs/heads/main moved to a foreign-`.gitignore` commit between check-ignore and diff children — payload called proven",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkRepo();
        writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
        const c1 = git(root, ["rev-parse", "HEAD"]);
        const c2 = makeForeignCommit(root);
        const mover = startHeadMover(root, c2, { fireOnChild: 1 });
        try {
          const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
          if (unproven === null) refused++;
          else if ([...unproven].includes("sub/payload")) honest++;
          else forged++;
        } finally {
          mover.stop();
          // Restore the judged state — the verdict must outlive the
          // provenance only as a returned artifact.
          writeFileSync(path.join(root, ".git", "refs", "heads", "main"), c1 + "\n");
        }
      }
      console.log(
        `HEAD-move between children: forged=${forged} refused=${refused} honest=${honest}`,
      );
      expect(forged).toBe(0);
    },
  );

  it(
    "caller level: statusDirty member verdict under a moved-and-restored HEAD",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkRepo();
        writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
        const c1 = git(root, ["rev-parse", "HEAD"]);
        const c2 = makeForeignCommit(root);
        const mover = startHeadMover(root, c2, { fireOnChild: 1 });
        try {
          let d: Awaited<ReturnType<typeof statusDirty>> | null = null;
          try {
            d = await statusDirty(root, ambientIo);
          } catch {
            d = null;
          }
          if (d === null) refused++;
          else if (d.entries.some((e) => e.slice(3).includes("sub/payload"))) honest++;
          else forged++;
        } finally {
          mover.stop();
          writeFileSync(path.join(root, ".git", "refs", "heads", "main"), c1 + "\n");
        }
      }
      console.log(`statusDirty HEAD-move: forged=${forged} refused=${refused} honest=${honest}`);
      expect(forged).toBe(0);
    },
  );
});
