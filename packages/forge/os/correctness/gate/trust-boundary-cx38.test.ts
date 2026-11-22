/*
RFC-1616 round-38 adversarial probes — independent clean-context
verification refuted R37 with two worktree-side classes orthogonal to
the whole R36 set:

CX-r38-W1 — tracked/untracked WORKTREE CONTENT was consulted live by
`status`, `diff`, `ls-files -o`, `add`, `check-ignore`… yet sat outside
every judged surface: the armed window watched only the `.git` tree, fp
maps pinned only `.git` files, and the write barrier covered objects +
index + caller extraWatchPaths. A same-UID adversary flipped tracked
bytes (or hid an untracked dirent) inside the judged child's lifetime,
restored before verdict, and the consult attested foreign bytes — no
silent-write channel needed.

Fix surface: the claims index (verifier-owned `ls-files --stage`) names
the tracked set; `captureWorktreeSurface` walks file stats + directory
member sets at PREFLIGHT; `worktreeArmPlan` folds every claims name
into lstat-pins + containing-dir name watches + a /proc write-channel
audit; the arm compares the live surface against the captured baseline
so a flip landing between capture and arm is drift, not a re-baseline.
Read consults pin without the 0400 barrier (its own chmod would read as
`core.fileMode` dirt); anchored `add` keeps the barrier (content
hashing is mode-blind) and attests arm-instant state.

CX-r38-W2 — worktree-ROOT rename exchange mid-window. The armed watch
followed `.git`'s INODE; nothing watched `<wt>`'s parent dirent or held
the resolution roots open, so `<wt>`↔`<foreign>` rename-exchanged the
armed inode aside untouched while `GIT_WORK_TREE`/
`GIT_OBJECT_DIRECTORY`/`GIT_DIR` resolved attacker bytes by name —
`status`/`diff`/`log`/check-ignore attestation all consumed the foreign
tree (the D2 attestation hole reopened too).

Fix surface: every path-valued env pin a judged spawn consults is
rewritten to `/proc/self/fd/<slot>`-relative inside `spawnCaptured`,
bound to fds the ARM opened after verifying each root's inode+ctime
against the fingerprint's preflight capture; each root's parent dirent
gets a basename-filtered watch so a rename exchange is a deterministic
event. Preflight/capture children stay name-bound by design — their
resolves are re-proven under the armed watch (fd-bound `--git-path`
output would poison the fingerprint with child-local `/proc/self/fd/N`
literals).

Attack shape in this file: a python watcher enumerates
`/proc/<vpid>/task/<tid>/children`, fires the flip/swap the instant the
judged child's argv matches, and restores on child exit — landing every
effect strictly inside the armed window (post-arm, pre-settle), the
shape the fix must refuse deterministically.

Outcomes: refused = exitCode -1 (EVIDENCE-REFUSED); honest = the
attacker's race missed the window and the verdict tracks real state;
forged = a verdict accepted attacker bytes — must stay 0.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { verifierGit } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx38w1-"));
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
 * W2 fixture: `<tmp>/wt` is the judged worktree (dirty), `<tmp>/foreign`
 * carries a copy of `.git` plus a CLEAN worktree file — the root-swap
 * payload. `stash` is the parking name for the exchange.
 */
const mkSwapFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx38w2-"));
  tmpdirs.push(root);
  const wt = path.join(root, "wt");
  execFileSync("git", ["init", "-q", "-b", "main", wt]);
  git(wt, ["config", "user.email", "t@t"]);
  git(wt, ["config", "user.name", "t"]);
  writeFileSync(path.join(wt, "policy.txt"), "COMMITTED\n");
  git(wt, ["add", "policy.txt"]);
  git(wt, ["commit", "-qm", "honest"]);
  writeFileSync(path.join(wt, "policy.txt"), "DIRTY\n");
  const foreign = path.join(root, "foreign");
  mkdirSync(foreign);
  cpSync(path.join(wt, ".git"), path.join(foreign, ".git"), { recursive: true });
  writeFileSync(path.join(foreign, "policy.txt"), "COMMITTED\n");
  execFileSync("chmod", ["-R", "u+w", path.join(foreign, ".git", "objects")]);
  return { root, wt, foreign, stash: path.join(root, "stash") };
};

const looseObj = (objectsDir: string, type: string, body: string, oid: string) => {
  const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), Buffer.from(body)]);
  const p = path.join(objectsDir, oid.slice(0, 2), oid.slice(2));
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, zlib.deflateSync(raw));
  chmodSync(p, 0o444);
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

describe("CX-r38-W1: tracked/untracked worktree content joins the judged surface", () => {
  it(
    "mid-window tracked-file flip→restore on `status --porcelain` refuses — never attests clean",
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
        writeFileSync(file, "DIRTY-BYTES-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n");
        // Adversary: when the judged `status` child spawns, overwrite
        // with committed bytes; restore dirty bytes on child exit.
        const h = startChildWatcher(
          process.pid,
          "status",
          `open(${pyStr(file)},'w').write('COMMITTED-BYTES-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n')`,
          `open(${pyStr(file)},'w').write('DIRTY-BYTES-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\\n')`,
        );
        try {
          const r = await verifierGit(root, ["status", "--porcelain"]);
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else {
            const out = r.stdout.trim();
            const dirtyNow = readFileSync(file).toString().startsWith("DIRTY-BYTES");
            if (out === "" && dirtyNow) forged++;
            else honest++;
          }
        } finally {
          h.stop();
        }
      }
      console.log(
        `W1a status tracked-flip in-window: forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );

  it(
    "mid-window tracked-file flip→restore on `diff --name-only HEAD` refuses",
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
        writeFileSync(file, "DIRTY-BYTES-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n");
        const h = startChildWatcher(
          process.pid,
          "diff",
          `open(${pyStr(file)},'w').write('COMMITTED-BYTES-AAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n')`,
          `open(${pyStr(file)},'w').write('DIRTY-BYTES-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\\n')`,
        );
        try {
          const r = await verifierGit(root, ["diff", "--name-only", "HEAD"]);
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else {
            const out = r.stdout.trim();
            const dirtyNow = readFileSync(file).toString().startsWith("DIRTY-BYTES");
            if (out === "" && dirtyNow) forged++;
            else honest++;
          }
        } finally {
          h.stop();
        }
      }
      console.log(
        `W1b diff tracked-flip in-window: forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );

  it(
    "mid-window untracked hide→restore on `status --porcelain` refuses — never hides the dirent",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let i = 0; i < 8; i++) {
        const root = mkRepo();
        const un = path.join(root, "un.txt");
        const hidden = path.join(root, ".hidden-un");
        writeFileSync(un, "untracked\n");
        const h = startChildWatcher(
          process.pid,
          "status",
          `import os\n            os.rename(${pyStr(un)},${pyStr(hidden)})`,
          `import os\n            os.rename(${pyStr(hidden)},${pyStr(un)})`,
        );
        try {
          const r = await verifierGit(root, ["status", "--porcelain"]);
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else {
            const out = r.stdout.trim();
            const restored = existsSync(un);
            if (!out.includes("un.txt") && restored) forged++;
            else honest++;
          }
        } finally {
          h.stop();
        }
      }
      console.log(
        `W1c status untracked-hide in-window: forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );

  it(
    "mid-window mode flip→restore on `status --porcelain` refuses — never fabricates dirt",
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
        // content stays committed; only the mode flips mid-window.
        const h = startChildWatcher(
          process.pid,
          "status",
          `import os\n            os.chmod(${pyStr(file)},0o755)`,
          `import os\n            os.chmod(${pyStr(file)},0o644)`,
        );
        try {
          const r = await verifierGit(root, ["status", "--porcelain"]);
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else {
            const out = r.stdout.trim();
            if (out.includes("policy.txt")) forged++;
            else honest++;
          }
        } finally {
          h.stop();
        }
      }
      console.log(
        `W1d status mode-flip in-window: forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});

describe("CX-r38-W2: worktree-root rename exchange cannot redirect resolution", () => {
  it(
    "mid-window root swap→restore on `status --porcelain` refuses — never serves the foreign tree",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let i = 0; i < 6; i++) {
        const { wt, foreign, stash } = mkSwapFixture();
        const h = startChildWatcher(
          process.pid,
          "status",
          `import os\n            os.rename(${pyStr(wt)},${pyStr(stash)})\n            os.rename(${pyStr(foreign)},${pyStr(wt)})`,
          `import os\n            os.rename(${pyStr(wt)},${pyStr(foreign)})\n            os.rename(${pyStr(stash)},${pyStr(wt)})`,
        );
        try {
          const r = await verifierGit(wt, ["status", "--porcelain"]);
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else {
            const out = r.stdout.trim();
            const dirtyNow =
              existsSync(path.join(wt, "policy.txt")) &&
              readFileSync(path.join(wt, "policy.txt")).toString() === "DIRTY\n";
            if (out === "" && dirtyNow) forged++;
            else honest++;
          }
        } finally {
          h.stop();
        }
      }
      console.log(
        `W2a root-swap status in-window: forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );

  it(
    "mid-window root swap→restore on `log -1` refuses — a foreign commit object never attests",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let i = 0; i < 6; i++) {
        const { wt, foreign, stash } = mkSwapFixture();
        const headSha = git(wt, ["rev-parse", "HEAD"]);
        const treeSha = git(wt, ["rev-parse", "HEAD^{tree}"]);
        looseObj(
          path.join(foreign, ".git", "objects"),
          "commit",
          `tree ${treeSha}\nauthor a <a@a> 1 +0000\ncommitter a <a@a> 1 +0000\n\nFORGED-COMMIT\n`,
          headSha,
        );
        const h = startChildWatcher(
          process.pid,
          "log",
          `import os\n            os.rename(${pyStr(wt)},${pyStr(stash)})\n            os.rename(${pyStr(foreign)},${pyStr(wt)})`,
          `import os\n            os.rename(${pyStr(wt)},${pyStr(foreign)})\n            os.rename(${pyStr(stash)},${pyStr(wt)})`,
        );
        try {
          const r = await verifierGit(wt, ["log", "-1", "--format=%s", "HEAD"]);
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else {
            const out = r.stdout.trim();
            if (out === "FORGED-COMMIT") forged++;
            else honest++;
          }
        } finally {
          h.stop();
        }
      }
      console.log(
        `W2b root-swap log in-window: forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
