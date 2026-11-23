/*
RFC-1616 round-43 adversarial probes — the clean-context verifier
refuted R43 with one finding, a second instance of the OPTARG class
the R43 `-u` fix modeled only halfway:

CX-r43-F1 — `statusConsultsUntracked` scanned each short cluster with
`indexOf("u")` on the premise that "`u` is the only optarg-bearing
short in status". Git 2.53 gives `-M` (`--find-renames[=<n>]`) the
same attached OPTARG, and the first optarg short in a cluster eats
the remainder as its value: `status -Muno` parses `-M` "uno" — NO
`-u` flag exists, so the untracked/ignored walk runs at default —
while the classifier read the `u` inside `-M`'s value as mode `no` →
`worktreeConsultScope` "tracked" → `armedDirs` undefined → no untracked
member-set watch/compare. A same-UID mutator watching
/proc/self/task/*\/children planted `evil/f` strictly inside the
child's lifetime and the judged output emitted `?? evil/` for a path
absent at both arm and settle (verifier tally 11/12; parent
reproduction 12/12 forged, 0 refused — both channels share
resolveWorktreeArm).

Fix: the status branch now walks cluster chars like the ls-files
model — `u` AND `M` are OPTARG shorts whose attached tail ends flag
parsing; only a `u` reached as an actual flag sets the mode.
Status's remaining shorts (-v/-s/-b/-z) are plain flags, and an
unknown short is a parse error in the child — an honest failure,
never a narrower arm.

Vulnerable family (all admitted): -Muno, -sMuno, -Msuno, -MMuno,
-vMuno, -zMuno, -M=uno — any `-M`-led cluster whose tail contains
`u`+`no`. Consistent controls: `status -M -uno` (separate tokens —
real -u flag), `-Mno` (over-arms, safe), `-uM` (fatal parse error in
the child).

Attack shape: identical to cx42 — a python watcher enumerates
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
  evidenceSpawnArgs,
  verifierGit,
  worktreeConsultScope,
} from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/** Tracked file + ignored dir + untracked dir — the F1 consult surface. */
const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx43-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, ".gitignore"), "ig/\n");
  writeFileSync(path.join(root, "tracked.txt"), "T\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "c1"]);
  mkdirSync(path.join(root, "ig"));
  writeFileSync(path.join(root, "ig", "inner"), "I\n");
  mkdirSync(path.join(root, "untr"));
  writeFileSync(path.join(root, "untr", "u.txt"), "U\n");
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

describe("CX-r43-F1: `-M`'s similarity optarg swallows the cluster tail", () => {
  it("the scope/descent classifiers agree with Git on the `-M…u…` family", () => {
    // `-M` led clusters eat the tail as the similarity value — no -u
    // flag exists, so the untracked walk stays ON (scope must arm it).
    for (const cluster of ["-Muno", "-sMuno", "-Msuno", "-MMuno", "-vMuno", "-zMuno", "-M=uno"]) {
      const argv = ["status", cluster, "--porcelain"];
      expect(worktreeConsultScope(argv), cluster).toBe("tracked+untracked");
      expect(consultDescendsIgnoredDirs(evidenceSpawnArgs(argv)), cluster).toBe(true);
    }
  });

  it("consistent controls: real `-u` flags and separate tokens still narrow", () => {
    // A `-u` reached as an actual flag still carries its attached mode.
    for (const argv of [
      ["status", "-uno", "--porcelain"],
      ["status", "-suno", "--porcelain"],
      ["status", "-M", "-uno", "--porcelain"], // -M bare, -uno a real flag
      ["status", "--untracked-files=no", "--porcelain"],
      ["status", "--un=no", "--porcelain"],
    ]) {
      expect(worktreeConsultScope(argv), JSON.stringify(argv)).toBe("tracked");
      expect(consultDescendsIgnoredDirs(evidenceSpawnArgs(argv)), JSON.stringify(argv)).toBe(false);
    }
  });

  it("safety: `-M`-only / `-u`-with-junk tails keep the walk armed (over-arm, never under)", () => {
    // `-Mno` has no u at all; `-uM`/-uxyz carry modes ≠ "no" — git may
    // error on junk modes but the verifier must never model "no".
    for (const argv of [
      ["status", "-Mno", "--porcelain"],
      ["status", "-vM", "--porcelain"],
      ["status", "-uM", "--porcelain"],
      ["status", "-uxyz", "--porcelain"],
      ["status", "-uall", "--porcelain"],
      ["status", "--porcelain"], // bare status walks untracked by default
    ]) {
      expect(worktreeConsultScope(argv), JSON.stringify(argv)).toBe("tracked+untracked");
      expect(consultDescendsIgnoredDirs(evidenceSpawnArgs(argv)), JSON.stringify(argv)).toBe(true);
    }
  });

  it(
    "a mid-window top-level plant on `status -Muno` refuses or stays honest — never forged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 8; i++) {
        const root = mkRepo();
        const evilDir = path.join(root, "evil");
        const h = startChildWatcher(
          process.pid,
          "-Muno",
          `os.mkdir(${pyStr(evilDir)}); open(${pyStr(path.join(evilDir, "f"))},'w').write('P\\n')`,
          `os.unlink(${pyStr(path.join(evilDir, "f"))}); os.rmdir(${pyStr(evilDir)})`,
        );
        try {
          const r = await verifierGit(root, ["status", "-Muno", "--porcelain"]);
          if (r.exitCode === -1) refused++;
          else if (r.stdout.includes("evil")) forged++;
          else honest++;
        } finally {
          h.stop();
          try {
            rmSync(evilDir, { recursive: true });
          } catch {
            /* absent */
          }
        }
      }
      expect(forged, "-Muno plant forge").toBe(0);
      expect(refused + honest).toBe(8);
      // The arm now engages — the member-set compare must catch at
      // least some races rather than the plant sailing through honest.
      expect(refused).toBeGreaterThan(0);
    },
  );

  it(
    "the same plant on `status -sMuno` refuses or stays honest — never forged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 4; i++) {
        const root = mkRepo();
        const evilDir = path.join(root, "evil");
        const h = startChildWatcher(
          process.pid,
          "-sMuno",
          `os.mkdir(${pyStr(evilDir)}); open(${pyStr(path.join(evilDir, "f"))},'w').write('P\\n')`,
          `os.unlink(${pyStr(path.join(evilDir, "f"))}); os.rmdir(${pyStr(evilDir)})`,
        );
        try {
          const r = await verifierGit(root, ["status", "-sMuno", "--porcelain"]);
          if (r.exitCode === -1) refused++;
          else if (r.stdout.includes("evil")) forged++;
          else honest++;
        } finally {
          h.stop();
          try {
            rmSync(evilDir, { recursive: true });
          } catch {
            /* absent */
          }
        }
      }
      expect(forged, "-sMuno plant forge").toBe(0);
      expect(refused + honest).toBe(4);
    },
  );

  it("the honest `-Muno` consult enumerates untracked + ignored like Git", async () => {
    const root = mkRepo();
    const r = await verifierGit(root, ["status", "-Muno", "--porcelain"]);
    expect(r.exitCode).toBe(0);
    const live = git(root, ["status", "-Muno", "--porcelain", "--ignored"]);
    expect(r.stdout).toContain("?? untr/");
    expect(r.stdout).toContain("!! ig/");
    // The verifier's output must equal the same argv run live.
    expect(r.stdout.trim()).toBe(live);
  });
});
