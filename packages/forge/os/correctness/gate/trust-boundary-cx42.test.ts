/*
RFC-1616 round-42 adversarial probes — the clean-context verifier
refuted R42 with two classes, both gaps INSIDE the R42 mechanisms:

CX-r42-F1 — `consultDescendsIgnoredDirs` evaluated the raw caller argv
while the judged child runs `evidenceSpawnArgs(args)`, and modeled
neither OPT_BOOL negation nor required-arg value consumption:
`--directory --no-directory` (and every unambiguous `--no-dir` abbrev)
leaves dirCollapse=true in the classifier while Git's last-wins parse
descends; `-o -x --directory` has `-x` eat `--directory` as its pattern
value so the spawned child is plain `ls-files -o` (descends) while the
classifier counted the shadowed token as collapse. Wrong verdict →
`worktreeArmPlan` pruned the ignored dirs → a mid-window plant inside
them was invisible yet emitted (22/32 forged across four argv shapes,
both channels). The same argv-model class hid a `status` bug the
verifier never probed: `-u`/`--untracked-files` are OPTARG (attached
mode only) — the space-form token is a PATHSPEC (`status -u no`
answers `?? no`), so `worktreeConsultScope`'s value consumption
under-armed the whole untracked scope, not just the ignored subset.
Fix: the classifier runs on the SPAWNED argv (shadowed tokens are
already gone) and models Git's parse faithfully — `--di*`/`--no-di*`
last-wins toggles, `--no-em*`/`--em*` no-empty toggles, `--o*`/`--no-o*`,
required-arg long options and `-x`/`-X` cluster tails consuming the
next token, and `-u` attached-only.

CX-r42-F3 — the `__evidence_dead__` upstream pins were carried as flat
`key=value` strings that `evidencePinEnv` re-split at the FIRST `=` to
encode `GIT_CONFIG_KEY_n`. `=` is a legal refname character: on branch
`a=b` the pin `branch.a=b.remote=…` encoded key `branch.a` (garbage),
never pinned `branch.a=b.*`, and a planted `remote=.` +
`merge=refs/heads/victim` upstream claim survived `status` verbatim
(4/4 leaked, deterministic). Fix: `EvidencePreflight.envPins` carries
pins as SPLIT key/value pairs end-to-end — the `GIT_CONFIG_KEY_n`/
`GIT_CONFIG_VALUE_n` transport holds `=` in keys verbatim while the
`-c` argv grammar cannot express them at all.

Attack shape: identical to cx40/cx41 — a python watcher enumerates
/proc/<vpid>/task/<tid>/children, fires on the judged child's argv,
and restores on zombie. Outcomes: refused = exitCode -1; honest =
true state at read instant; forged = verdict accepted attacker bytes
— must stay 0.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  consultDescendsIgnoredDirs,
  evidenceRepoPreflight,
  evidencePinEnv,
  verifierGit,
  worktreeConsultScope,
} from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/** Same ignored-interior fixture as cx41 — `ig/` is check-ignore-ignored. */
const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx42-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, ".gitignore"), "ig/\n");
  writeFileSync(path.join(root, "policy.txt"), "COMMITTED\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "c1"]);
  mkdirSync(path.join(root, "ig"));
  writeFileSync(path.join(root, "ig", "inner0"), "I0\n");
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

describe("CX-r42-F1: the descent classifier models the spawned child's parse", () => {
  it(
    "mid-window plant inside an ignored dir on `ls-files -o --directory --no-directory` refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkRepo();
        const planted = path.join(root, "ig", "evil");
        const h = startChildWatcher(
          process.pid,
          "--no-directory",
          `open(${pyStr(planted)},'w').write('FORGED\\n')`,
          `os.unlink(${pyStr(planted)})`,
        );
        try {
          const r = await verifierGit(root, ["ls-files", "-o", "--directory", "--no-directory"]);
          if (r.exitCode === -1) refused++;
          else if (r.stdout.includes("ig/evil")) forged++;
          else honest++;
        } finally {
          h.stop();
          try {
            rmSync(planted);
          } catch {
            /* absent */
          }
        }
      }
      expect(forged, "--no-directory negation forge").toBe(0);
      expect(refused + honest).toBe(6);
    },
  );

  it(
    "the same plant refuses on `ls-files -o -x --directory` (value shadow)",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkRepo();
        const planted = path.join(root, "ig", "evil");
        // The spawned argv is `ls-files -o` (the -x pair strips) — the
        // judged child is the only `ls-files -o` consult in the window.
        const h = startChildWatcher(
          process.pid,
          "-o",
          `open(${pyStr(planted)},'w').write('FORGED\\n')`,
          `os.unlink(${pyStr(planted)})`,
        );
        try {
          const r = await verifierGit(root, ["ls-files", "-o", "-x", "--directory"]);
          if (r.exitCode === -1) refused++;
          else if (r.stdout.includes("ig/evil")) forged++;
          else honest++;
        } finally {
          h.stop();
          try {
            rmSync(planted);
          } catch {
            /* absent */
          }
        }
      }
      expect(forged, "-x value-shadow forge").toBe(0);
      expect(refused + honest).toBe(6);
    },
  );

  it(
    "gitEvidence refuses the `--directory --no-directory` plant identically",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkRepo();
        const planted = path.join(root, "ig", "evil");
        const h = startChildWatcher(
          process.pid,
          "--no-directory",
          `open(${pyStr(planted)},'w').write('FORGED\\n')`,
          `os.unlink(${pyStr(planted)})`,
        );
        try {
          const r = await gitEvidence(root, ["ls-files", "-o", "--directory", "--no-directory"]);
          if (r.exitCode === -1) refused++;
          else if (r.stdout.includes("ig/evil")) forged++;
          else honest++;
        } finally {
          h.stop();
          try {
            rmSync(planted);
          } catch {
            /* absent */
          }
        }
      }
      expect(forged, "gitEvidence --no-directory forge").toBe(0);
      expect(refused + honest).toBe(6);
    },
  );

  it(
    "mid-window plant under a `-u no` pathspec refuses — the space-form token is not the mode",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkRepo();
        // Pathspec `no` matches `nope` — a top-level plant the child
        // enumerates while a `tracked` scope would arm nothing.
        const planted = path.join(root, "nope");
        const h = startChildWatcher(
          process.pid,
          "-u",
          `open(${pyStr(planted)},'w').write('FORGED\\n')`,
          `os.unlink(${pyStr(planted)})`,
        );
        try {
          const r = await verifierGit(root, ["status", "-u", "no", "--porcelain"]);
          if (r.exitCode === -1) refused++;
          else if (r.stdout.includes("nope")) forged++;
          else honest++;
        } finally {
          h.stop();
          try {
            rmSync(planted);
          } catch {
            /* absent */
          }
        }
      }
      expect(forged, "-u no pathspec forge").toBe(0);
      expect(refused + honest).toBe(6);
    },
  );

  it("classifier: `--dir*`/`--no-di*` negation toggles last-wins", () => {
    // Collapse flag — full name and every unambiguous abbreviation.
    for (const flag of ["--di", "--dir", "--dire", "--director", "--directory"]) {
      expect(consultDescendsIgnoredDirs(["ls-files", "-o", flag]), `${flag} collapses`).toBe(false);
    }
    // Negation unlatches it — Git's OPT_BOOL last-wins.
    for (const flag of ["--no-di", "--no-dir", "--no-direc", "--no-directory"]) {
      expect(
        consultDescendsIgnoredDirs(["ls-files", "-o", "--directory", flag]),
        `--directory ${flag} descends`,
      ).toBe(true);
      // And collapse wins when it lands last.
      expect(
        consultDescendsIgnoredDirs(["ls-files", "-o", flag, "--directory"]),
        `${flag} --directory collapses`,
      ).toBe(false);
    }
    // `--no-empty-directory` breaks the collapse (emptiness probe opens
    // interior dirents); `--empty-directory` negations restore it.
    for (const flag of ["--no-em", "--no-emp", "--no-empty", "--no-empty-directory"]) {
      expect(
        consultDescendsIgnoredDirs(["ls-files", "-o", "--directory", flag]),
        `--directory ${flag} descends`,
      ).toBe(true);
    }
    for (const flag of ["--em", "--emp", "--empty", "--empty-directory"]) {
      expect(
        consultDescendsIgnoredDirs(["ls-files", "-o", "--directory", "--no-empty-directory", flag]),
        `--empty negation collapses`,
      ).toBe(false);
    }
    // `--others` suppressed: no untracked walk at all.
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "--no-others"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "--no-o"])).toBe(false);
  });

  it("classifier: required-arg options consume the next token whole", () => {
    // `-x`/`-X` and every valued `--exclude*`/`--with-tree` hide the
    // following token from flag parsing — on the judged argv too.
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "-x", "--directory"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "-X", "--directory"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "--exclude-from", "--directory"])).toBe(
      true,
    );
    expect(
      consultDescendsIgnoredDirs(["ls-files", "-o", "--exclude-per-directory", "--directory"]),
    ).toBe(true);
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "--with-tree", "--directory"])).toBe(true);
    // Cluster tail is the value — `o` after `-X` is a filename, not `-o`.
    expect(consultDescendsIgnoredDirs(["ls-files", "-Xo"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "-Xo"])).toBe(true);
    // A real valued flag + a later collapse flag still collapses.
    expect(
      consultDescendsIgnoredDirs(["ls-files", "-o", "--with-tree", "HEAD", "--directory"]),
    ).toBe(false);
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "-x", "pat", "--directory"])).toBe(false);
    // `--abbrev` is OPTARG — space-form does NOT consume; the following
    // token stays a flag/pathspec.
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "--abbrev", "--directory"])).toBe(false);
    // The classifier also classifies the SPAWNED argv correctly — the
    // strip already removed every exclusion pair.
    expect(consultDescendsIgnoredDirs(["ls-files", "-o"])).toBe(true);
  });

  it("status `-u` is OPTARG — bare forms leave the untracked walk on", () => {
    // Attached forms disable.
    expect(consultDescendsIgnoredDirs(["status", "-uno"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["status", "-suno"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["status", "--untracked-files=no"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["status", "--u=no"])).toBe(false);
    // Bare/space forms — the next token is a pathspec, not the mode.
    expect(consultDescendsIgnoredDirs(["status", "-u", "no"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["status", "--untracked-files", "no"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["status", "-u"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["status", "--untracked-files"])).toBe(true);
    // Other modes stay descending.
    expect(consultDescendsIgnoredDirs(["status", "-uall"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["status", "--untracked-files=normal"])).toBe(true);
  });

  it("worktreeConsultScope mirrors the same `-u` parse", () => {
    expect(worktreeConsultScope(["status", "-u", "no"])).toBe("tracked+untracked");
    expect(worktreeConsultScope(["status", "--untracked-files", "no"])).toBe("tracked+untracked");
    expect(worktreeConsultScope(["status", "-uno"])).toBe("tracked");
    expect(worktreeConsultScope(["status", "--untracked-files=no"])).toBe("tracked");
    expect(worktreeConsultScope(["status", "--porcelain"])).toBe("tracked+untracked");
  });
});

describe("CX-r42-F3: `=`-bearing branch names pin via split key/value env", () => {
  const mkEqRepo = (branch: string) => {
    const root = mkRepo();
    try {
      git(root, ["checkout", "-qb", branch]);
    } catch {
      return null;
    }
    // A resolvable session-authored upstream the dead pin must
    // neutralize — `remote=.` + a local branch resolves, so a live
    // lever prints a tracking line verbatim.
    git(root, ["branch", "victim"]);
    git(root, ["config", `branch.${branch}.remote`, "."]);
    git(root, ["config", `branch.${branch}.merge`, "refs/heads/victim"]);
    return root;
  };

  it("status on `a=b` emits no session-authored upstream claim", async () => {
    const root = mkEqRepo("a=b");
    expect(root, "git refused the a=b refname").not.toBeNull();
    const r = await verifierGit(root!, ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/ahead|behind|up to date|gone/i);
    const rg = await gitEvidence(root!, ["status"]);
    expect(rg.exitCode).toBe(0);
    expect(rg.stdout).not.toMatch(/ahead|behind|up to date|gone/i);
  });

  it("evidencePinEnv carries `branch.<name>.*` as verbatim GIT_CONFIG_KEY_n", async () => {
    const root = mkEqRepo("a=b");
    expect(root).not.toBeNull();
    const pre = await evidenceRepoPreflight(root!);
    expect(pre).not.toBeNull();
    const env = evidencePinEnv(["status"], pre);
    const pairs = Object.entries(env)
      .filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
      .map(([k, v]) => [v, env[`GIT_CONFIG_VALUE_${k.slice("GIT_CONFIG_KEY_".length)}`]] as const);
    expect(pairs).toContainEqual(["branch.a=b.remote", "__evidence_dead__"]);
    expect(pairs).toContainEqual(["branch.a=b.merge", "refs/heads/__evidence_dead__"]);
    expect(pairs).toContainEqual(["branch.a=b.pushremote", "__evidence_dead__"]);
    // `config` reads withhold every pin — the `envPins` channel follows
    // the same precedence-shadow rule as the `-c` set.
    const cenv = evidencePinEnv(["config", "--get", "branch.a=b.remote"], pre);
    expect(
      Object.entries(cenv).some(
        ([k, v]) => k.startsWith("GIT_CONFIG_KEY_") && v === "branch.a=b.remote",
      ),
    ).toBe(false);
  });

  it.each(["a%b", "a|b", "a&b", "a+b", "a#b", "feat/üñï"])(
    "status on armable name %j still emits no upstream claim",
    async (branch) => {
      const root = mkEqRepo(branch);
      if (root === null) return; // refname not accepted on this git
      const r = await verifierGit(root, ["status"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toMatch(/ahead|behind|up to date|gone/i);
    },
  );
});
