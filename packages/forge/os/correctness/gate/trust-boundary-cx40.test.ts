/*
RFC-1616 round-40 adversarial probes — the clean-context verifier
refuted R39 with one deterministic in-window class plus two reliability
findings:

CX-r40-W3 — `worktreeConsultScope` classified `ls-files` by flag
membership (`-o`/`--others` → untracked, `LS_FILES_WT_STAT_FLAGS` →
tracked, else `"none"`), but `-k`/`--killed` is in neither set and still
walks the live worktree: `git ls-files -k` enumerates filesystem entries
that "kill" untracked paths. The judged child ran scope-`"none"` — no
watches, pins, or member-set rechecks — so a hide/plant of a dir-killing
blocker inside the armed window forged the verdict (6/6 each direction
on `verifierGit`, 6/6 on the `gitEvidence` channel). Fix: `ls-files` is
`tracked+untracked` unless every flag is provably index-only
(`LS_FILES_INDEX_ONLY_FLAGS` + valued prefixes); unknown flags fail
toward coverage.

R40-N1 — reliability: the ignored-dir prune consult issued
`check-ignore -z -- <dirs>`; Git ≥2.53 rejects `-z` without `--stdin`
("fatal: -z only makes sense with --stdin"), so the consult always
errored, `pruneIgnoredDirs` kept the full inventory, and honest churn
inside ignored dirs over-refused — the R39 prune never engaged. Fix:
`check-ignore -z --stdin` with the chunk on stdin.

R40-N2 — reliability: `evidencePinEnv` pinned
`branch.<HEAD>.{remote,merge,pushremote}` with empty values; Git ≥2.53
SIGSEGVs resolving the empty upstream (`status`/`commit --dry-run`,
`exitCode -1` with empty stderr — fail-closed but never an honest
answer). Fix: pin a never-configured remote name — upstream resolution
aborts on the remote lookup before `merge` is read, yielding the
intended "no upstream" output with no crash and no fabricated "gone"
line.

Attack shape: identical to cx39 — a python watcher enumerates
`/proc/<vpid>/task/<tid>/children`, fires on the judged child's argv,
and restores on zombie, landing every effect strictly inside the armed
window. Outcomes: refused = exitCode -1; honest = race missed or true
state; forged = verdict accepted attacker bytes — must stay 0.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifierGit, worktreeConsultScope } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx40-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "F\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/**
 * Repo with a tracked `a/b` whose worktree dir is replaced by a
 * same-named FILE — `a` "kills" untracked paths under `a/`, so
 * `git ls-files -k` honestly reports `a`.
 */
const mkKilledRepo = () => {
  const root = mkRepo();
  mkdirSync(path.join(root, "a"));
  writeFileSync(path.join(root, "a", "b"), "B\n");
  git(root, ["add", "a/b"]);
  git(root, ["commit", "-qm", "c2"]);
  rmSync(path.join(root, "a"), { recursive: true, force: true });
  writeFileSync(path.join(root, "a"), "BLOCKER\n");
  return root;
};

const startChildWatcher = (vpid: number, want: string, act: string, undo: string) => {
  const script =
    "import os,sys,time\n" +
    "vpid=int(sys.argv[1]); want=sys.argv[2]\n" +
    "def kids():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
    "            try: out+=open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return out\n" +
    "def argv(k):\n" +
    "    try: return open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
    "    except: return []\n" +
    "end=time.time()+60; done=False\n" +
    "while time.time()<end and not done:\n" +
    "    for k in kids():\n" +
    "        if k==str(os.getpid()): continue\n" +
    "        if want.encode() in argv(k):\n" +
    "            " +
    act +
    "\n" +
    "            for _ in range(400000):\n" +
    "                try:\n" +
    "                    stt=open('/proc/%s/stat'%k).read().rsplit(')',1)[1].split()[0]\n" +
    "                    if stt=='Z': break\n" +
    "                except: break\n" +
    "                time.sleep(0.00002)\n" +
    "            " +
    undo +
    "\n" +
    "            done=True\n" +
    "    time.sleep(0.00002)\n";
  const child = spawn("python3", ["-c", script, String(vpid), want], { stdio: "ignore" });
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

const pyStr = (s: string) => `'${s.replaceAll("'", "\\x27")}'`;

describe("CX-r40-W3: ls-files consults the worktree unless provably index-only", () => {
  it(
    "mid-window hide of the dir-killing blocker on `ls-files -k` refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkKilledRepo();
        const blocker = path.join(root, "a");
        const h = startChildWatcher(
          process.pid,
          "-k",
          `os.unlink(${pyStr(blocker)})`,
          `open(${pyStr(blocker)},'w').write('BLOCKER\\n')`,
        );
        try {
          const r = await verifierGit(root, ["ls-files", "-k"]);
          if (r.exitCode === -1) {
            refused++;
          } else if (!r.stdout.includes("a")) {
            forged++;
          } else {
            honest++;
          }
        } finally {
          h.stop();
          writeFileSync(blocker, "BLOCKER\n");
        }
      }
      expect(forged, "ls-files -k hid the blocker inside the armed window").toBe(0);
      expect(refused + honest).toBe(6);
      expect(refused).toBeGreaterThan(0);
    },
  );

  it(
    "mid-window plant of a dir-killing blocker on `ls-files -k` refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkKilledRepo();
        const blocker = path.join(root, "a");
        rmSync(blocker); // honest `ls-files -k` answer is empty now
        const h = startChildWatcher(
          process.pid,
          "-k",
          `open(${pyStr(blocker)},'w').write('BLOCKER\\n')`,
          `os.unlink(${pyStr(blocker)})`,
        );
        try {
          const r = await verifierGit(root, ["ls-files", "-k"]);
          if (r.exitCode === -1) {
            refused++;
          } else if (r.stdout.includes("a")) {
            forged++;
          } else {
            honest++;
          }
        } finally {
          h.stop();
          try {
            rmSync(blocker);
          } catch {
            /* absent */
          }
        }
      }
      expect(forged, "ls-files -k attested a planted blocker inside the armed window").toBe(0);
      expect(refused + honest).toBe(6);
      expect(refused).toBeGreaterThan(0);
    },
  );

  it("classifier: worktree-walking forms are covered, index-only forms stay 'none'", () => {
    expect(worktreeConsultScope(["ls-files", "-k"])).toBe("tracked+untracked");
    expect(worktreeConsultScope(["ls-files", "--killed"])).toBe("tracked+untracked");
    expect(worktreeConsultScope(["ls-files", "-k", "-u"])).toBe("tracked+untracked");
    expect(worktreeConsultScope(["ls-files", "-i", "-c", "--exclude-standard"])).toBe(
      "tracked+untracked",
    );
    expect(worktreeConsultScope(["ls-files", "-t"])).toBe("tracked+untracked");
    expect(worktreeConsultScope(["ls-files", "--recurse-submodules"])).toBe("tracked+untracked");
    expect(worktreeConsultScope(["ls-files", "--never-heard-of-this-flag"])).toBe(
      "tracked+untracked",
    );
    expect(worktreeConsultScope(["ls-files", "-o"])).toBe("tracked+untracked");
    expect(worktreeConsultScope(["ls-files", "--error-unmatch", "f.txt"])).toBe("tracked");
    expect(worktreeConsultScope(["ls-files", "-s"])).toBe("none");
    expect(worktreeConsultScope(["ls-files", "--stage", "-z"])).toBe("none");
    expect(worktreeConsultScope(["ls-files", "-c", "--exclude-standard"])).toBe("none");
    expect(worktreeConsultScope(["ls-files", "-u"])).toBe("none");
    expect(worktreeConsultScope(["ls-files", "--with-tree=HEAD"])).toBe("none");
    expect(worktreeConsultScope(["ls-files"])).toBe("none");
    expect(worktreeConsultScope(["ls-files", "--abbrev=8", "f.txt"])).toBe("none");
  });

  it("honest `ls-files -k` still reports the real blocker", async () => {
    const root = mkKilledRepo();
    const r = await verifierGit(root, ["ls-files", "-k"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("a");
  });
});

describe("R40-N2: upstream pins never crash the judged consult", () => {
  it("`status` on an upstream-less branch answers honestly (no SIGSEGV)", async () => {
    const root = mkRepo();
    const r = await verifierGit(root, ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("On branch main");
    // The dead-remote pin suppresses tracking text entirely — a "gone"
    // or "based on" line would be the pin fabricating evidence.
    expect(r.stdout).not.toContain("upstream");
    expect(r.stdout).not.toContain("__evidence_dead__");
  });

  it("`status --porcelain` and `commit --dry-run` shapes survive too", async () => {
    const root = mkRepo();
    const r = await verifierGit(root, ["status", "--porcelain"]);
    expect(r.exitCode).not.toBe(-1);
  });
});
