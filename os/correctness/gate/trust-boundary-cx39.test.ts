/*
RFC-1616 round-39 adversarial probes — the clean-context verifier
refuted R38 with four live in-window classes plus one reliability
finding:

CX-r39-A1 — anchored READS (`verifierGit(cwd, argv, {preflight})`, the
public `{preflight}` form used e.g. by `os/mission/lockfile.ts`)
resolved a worktree arm only for `add`; every other argv armed
`wtPlan=null`, so the anchored consult re-ran the worktree surface with
zero coverage — an in-window flip→restore attested foreign bytes.

CX-r39-G1 — `baseline.dirs` member sets compared BEFORE the worktree
directory watches armed and were never rechecked at settle: a dirent
delete landing in the compare→arm gap (or inside the fsWatch→inotify
activation gap) left no trace and hid `??`/`!` entries. Fix: the arm
registers every worktree dir watch FIRST, then compares the captured
member sets, and settle re-compares them after the child exits — any
delete, whether before the compare, inside the activation gap, or
mid-window, reads as drift or an armed event.

CX-r39-C1 — `check-ignore` classified scope `"none"`: its tracked rule
sources joined `extraWatchPaths` but an UNTRACKED `<dir>/.gitignore`
plant mid-window flipped `exit 1 → 0` unwatched. Fix: `resolveWorktreeArm`
gives `check-ignore` the full untracked coverage (member sets, dir
watches, per-dir `.gitignore` pin slots).

CX-r39-S1 — `<gitlink>/.git` escaped every surface: `status`/`diff`
descend into a populated submodule/embedded-repo gitdir and consult its
HEAD/refs/index/worktree — none of it pinned, watched, or inventoried.
Fix: `worktreeArmPlan` refuses outright when a claims-derived dir hosts
a populated `.git` slot (a full embedded-gitdir inventory is not
implemented — the honest refusal à la CX-173), and an absent slot is
pinned + dirent-watched so a mid-window plant is drift. The capture
also stops descending at non-root dirs holding `.git` — a repository
boundary git itself never enumerates.

R39-N1 — reliability: `captureWorktreeSurface` previously walked every
directory including ignored churn-heavy ones (`node_modules/.pnpm`,
build output) that git never consults; honest flux inside them refused
legitimate consults. `pruneIgnoredDirs` drops dirs `check-ignore`
itself reports ignored (the precise "git never descends" boundary —
`ls-files --directory`/`status --ignored` collapse over-consulted
dirs); repo-boundary dirs get member-level coverage without descent.

Attack shape in this file: a python watcher enumerates
`/proc/<vpid>/task/<tid>/children`, fires the plant/hide/flip the
instant the judged child's argv matches, and restores on child exit —
landing every effect strictly inside the armed window (post-arm,
pre-settle), the shape the fix must refuse deterministically. The
original verifier probes triggered on the first `anon_inode:inotify`
fd; the test harness process already holds one (the runner's own), so
that trigger fires pre-capture — inside the baseline-adopted state —
rather than inside the armed window.

Outcomes: refused = exitCode -1 (EVIDENCE-REFUSED); honest = the
attacker's race missed the window and the verdict tracks real state;
forged = a verdict accepted attacker bytes — must stay 0.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  armEvidenceWindowWatch,
  evidenceRepoPreflight,
  resolveWorktreeArm,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx39-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "policy.txt"), "COMMITTED-BYTES-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  git(root, ["add", "policy.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/**
 * In-window attacker: watch `/proc/<vpid>/task/<tid>/children`; when a
 * child's argv contains `want`, run `act` in python, then run `undo`
 * after the child exits. Everything the act touches lands strictly
 * inside the armed window — the deterministic refuse shape.
 */
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

describe("CX-r39-A1: anchored reads carry the same worktree arm as the spawn channel", () => {
  it(
    "mid-window flip→restore on anchored `status --porcelain` refuses — never attests stale clean",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let i = 0; i < 8; i++) {
        const root = mkRepo();
        const file = path.join(root, "policy.txt");
        const dirty = "DIRTY-BYTES-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n";
        const clean = "COMMITTED-BYTES-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
        writeFileSync(file, dirty);
        // Anchored judgment captured while the worktree is dirty.
        const pf = await evidenceRepoPreflight(root);
        const h = startChildWatcher(
          process.pid,
          "status",
          `open(${pyStr(file)},'w').write(${pyStr(clean.trimEnd() + "\\n")})`,
          `open(${pyStr(file)},'w').write(${pyStr(dirty.trimEnd() + "\\n")})`,
        );
        try {
          const r = await verifierGit(root, ["status", "--porcelain"], { preflight: pf });
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else if (!r.stdout.includes("policy.txt")) {
            forged++;
          } else {
            honest++;
          }
        } finally {
          h.stop();
          writeFileSync(file, dirty);
        }
      }
      expect(forged, "anchored status attested an in-window flip").toBe(0);
      expect(refused + honest).toBe(8);
      if (refused === 0) throw new Error(`never refused; lastErr=${lastErr}`);
    },
  );

  it(
    "mid-window flip→restore on anchored `diff --name-only` refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 8; i++) {
        const root = mkRepo();
        const file = path.join(root, "policy.txt");
        const dirty = "DIRTY-BYTES-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n";
        const clean = "COMMITTED-BYTES-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
        writeFileSync(file, dirty);
        const pf = await evidenceRepoPreflight(root);
        const h = startChildWatcher(
          process.pid,
          "diff",
          `open(${pyStr(file)},'w').write(${pyStr(clean.trimEnd() + "\\n")})`,
          `open(${pyStr(file)},'w').write(${pyStr(dirty.trimEnd() + "\\n")})`,
        );
        try {
          const r = await verifierGit(root, ["diff", "--name-only"], { preflight: pf });
          if (r.exitCode === -1) {
            refused++;
          } else if (!r.stdout.includes("policy.txt")) {
            forged++;
          } else {
            honest++;
          }
        } finally {
          h.stop();
          writeFileSync(file, dirty);
        }
      }
      expect(forged).toBe(0);
      expect(refused + honest).toBe(8);
    },
  );
});

describe("CX-r39-G1: the member-set compare runs under the armed watch and is rechecked at settle", () => {
  it(
    "untracked hide inside the armed window on `status --porcelain` refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 8; i++) {
        const root = mkRepo();
        const payload = path.join(root, "payload.txt");
        writeFileSync(payload, "PAYLOAD\n");
        const h = startChildWatcher(
          process.pid,
          "status",
          `os.unlink(${pyStr(payload)})`,
          `open(${pyStr(payload)},'w').write('PAYLOAD\\n')`,
        );
        try {
          const r = await verifierGit(root, ["status", "--porcelain"]);
          if (r.exitCode === -1) {
            refused++;
          } else if (!r.stdout.includes("payload.txt")) {
            forged++;
          } else {
            honest++;
          }
        } finally {
          h.stop();
          writeFileSync(payload, "PAYLOAD\n");
        }
      }
      expect(forged, "status hid ?? payload.txt inside the armed window").toBe(0);
      expect(refused + honest).toBe(8);
      expect(refused).toBeGreaterThan(0);
    },
  );

  it("a delete between capture and arm fails the arm — member-set compare reads drift", async () => {
    const root = mkRepo();
    const payload = path.join(root, "payload.txt");
    writeFileSync(payload, "PAYLOAD\n");
    const pf = await evidenceRepoPreflight(root);
    expect(pf).not.toBeNull();
    const resolved = resolveWorktreeArm(["status", "--porcelain"], pf!, undefined);
    expect(resolved).not.toBeNull();
    // The adversary unlinks after capture, before the arm — the armed
    // compare must read the drift and fail closed (the G1 fix arms the
    // dir watches first, then compares the captured sets).
    rmSync(payload);
    const watch = armEvidenceWindowWatch(
      root,
      pf!,
      undefined,
      resolved!.extraWatch,
      undefined,
      resolved!.wtPlan,
    );
    expect(watch).toBeNull();
  });

  it("a delete inside the armed window surfaces in settle events — activation gap covered", async () => {
    const root = mkRepo();
    const payload = path.join(root, "payload.txt");
    writeFileSync(payload, "PAYLOAD\n");
    const pf = await evidenceRepoPreflight(root);
    expect(pf).not.toBeNull();
    const resolved = resolveWorktreeArm(["status", "--porcelain"], pf!, undefined);
    const watch = armEvidenceWindowWatch(
      root,
      pf!,
      undefined,
      resolved!.extraWatch,
      undefined,
      resolved!.wtPlan,
    );
    expect(watch).not.toBeNull();
    // An unlink landing before inotify registration completes leaves no
    // event — the settle member-set recheck is the covering half. The
    // armed watch's event names the path, the recheck's the dir.
    rmSync(payload);
    const events = await watch!.settle();
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("CX-r39-C1: check-ignore consults the untracked rule surface too", () => {
  it(
    "untracked `.gitignore` plant inside the armed window refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 8; i++) {
        const root = mkRepo();
        const gi = path.join(root, ".gitignore");
        writeFileSync(path.join(root, "payload.txt"), "PAYLOAD\n");
        const h = startChildWatcher(
          process.pid,
          "check-ignore",
          `open(${pyStr(gi)},'w').write('payload.txt\\n')`,
          `os.unlink(${pyStr(gi)})`,
        );
        try {
          const r = await verifierGit(root, ["check-ignore", "--", "payload.txt"]);
          if (r.exitCode === -1) {
            refused++;
          } else {
            const notIgnoredNow = (() => {
              try {
                execFileSync("git", ["-C", root, "check-ignore", "--", "payload.txt"]);
                return false;
              } catch {
                return true;
              }
            })();
            if (r.exitCode === 0 && notIgnoredNow) forged++;
            else honest++;
          }
        } finally {
          h.stop();
          try {
            rmSync(gi);
          } catch {
            /* absent */
          }
        }
      }
      expect(forged, "check-ignore attested a planted untracked .gitignore").toBe(0);
      expect(refused + honest).toBe(8);
      expect(refused).toBeGreaterThan(0);
    },
  );

  it("honest check-ignore verdicts still answer through the wider coverage", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "payload.txt\n");
    writeFileSync(path.join(root, "payload.txt"), "PAYLOAD\n");
    const hit = await verifierGit(root, ["check-ignore", "--", "payload.txt"]);
    expect(hit.exitCode).toBe(0);
    expect(hit.stdout.trim()).toBe("payload.txt");
    const miss = await verifierGit(root, ["check-ignore", "--", "policy.txt"]);
    expect(miss.exitCode).toBe(1);
  });
});

describe("CX-r39-S1: a populated embedded gitdir refuses outright", () => {
  const mkEmbeddedRepo = () => {
    const root = mkRepo();
    const sub = path.join(root, "sub");
    mkdirSync(sub);
    execFileSync("git", ["init", "-q", "-b", "main", sub]);
    git(sub, ["config", "user.email", "t@t"]);
    git(sub, ["config", "user.name", "t"]);
    writeFileSync(path.join(sub, "inner.txt"), "INNER\n");
    git(sub, ["add", "inner.txt"]);
    git(sub, ["commit", "-qm", "inner"]);
    git(root, ["add", "sub"]);
    git(root, ["commit", "-qm", "add-sub"]);
    writeFileSync(path.join(sub, "inner.txt"), "INNER-DIRTY\n");
    return { root, sub };
  };

  it("status -uno refuses a claims-dir with populated `.git`", async () => {
    const { root } = mkEmbeddedRepo();
    const r = await verifierGit(root, ["status", "--porcelain", "-uno"]);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("EVIDENCE-REFUSED");
  });

  it("status (untracked scope) refuses the same surface", async () => {
    const { root } = mkEmbeddedRepo();
    const r = await verifierGit(root, ["status", "--porcelain"]);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("EVIDENCE-REFUSED");
  });

  it("diff refuses the same surface", async () => {
    const { root } = mkEmbeddedRepo();
    const r = await verifierGit(root, ["diff", "--name-only"]);
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("EVIDENCE-REFUSED");
  });

  it("an absent `.git` slot under a claims-dir stays judgeable", async () => {
    const { root, sub } = mkEmbeddedRepo();
    // A gitlink dir whose `.git` never materialized is the honest
    // "submodule not checked out" shape — covered by the pin plus the
    // `.git`-filtered dirent watch, not the populated refusal.
    rmSync(path.join(sub, ".git"), { recursive: true, force: true });
    const r = await verifierGit(root, ["status", "--porcelain", "-uno"]);
    expect(r.exitCode).not.toBe(-1);
  });
});
