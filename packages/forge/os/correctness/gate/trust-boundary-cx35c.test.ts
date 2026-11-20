/*
CX-r35-C (read channel, window shape): r35-S1c flipped
`refs/heads/main` under a bare `verifierGit(root, ["diff",
"--name-only","-z","HEAD"])` — the consult resolved HEAD→C' (a commit
whose tree carries the dirty worktree bytes), so a dirty `f.txt`
answered empty/clean: forged 5/5. The stat-pinned loose ref is
git-legit-writable, so a mid-window mmap flip→restore is silent to
every inotify/stat layer.

Fix: the judged child resolves refs through the verifier-owned
overlay gitdir — captured bytes, never the live path — so no live
flip ordering can shape `HEAD`. A flip held through settle ends
live≠minted (the window's byte re-proof refuses); a flip→restore
inside the consult ends consistent and the verdict is honest (the
consult saw the repo's ending state). Neither shape can produce the
forged-empty diff.

forged = exit 0 with empty stdout (C'-shaped diff); refused = exit
-1; honest = exit 0 listing `f.txt`.
*/
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifierGit } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;
const HAS_MMAP = HAS_PY && spawnSync("python3", ["-c", "import mmap"]).status === 0;

/**
 * Window-mode flip: store C' when a `diff` child of the verifier
 * appears, restore after a short hold — covering both orderings
 * (restore before settle → honest; held through settle → refused).
 */
const startWindowFlip = (
  refPath: string,
  cPrime: string,
  cOid: string,
  vpid: number,
  log: string,
) => {
  const script =
    "import os,sys,mmap,time\n" +
    "refpath,forged_hex,orig_hex,vpid,logpath=sys.argv[1:6]\n" +
    "fd=os.open(refpath,os.O_RDWR); st0=os.fstat(fd)\n" +
    "m=mmap.mmap(fd,st0.st_size,mmap.MAP_SHARED,mmap.PROT_READ|mmap.PROT_WRITE)\n" +
    "_=m[0]; m[:]=(orig_hex+'\\n').encode()\n" +
    "log=open(logpath,'a'); t0=time.time()\n" +
    "def lg(m): log.write('%.1f %s\\n'%((time.time()-t0)*1000,m)); log.flush()\n" +
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
    "end=time.time()+30\n" +
    "while time.time()<end:\n" +
    "    for k in kids():\n" +
    "        if b'diff' in argv(k):\n" +
    "            m[:]=(forged_hex+'\\n').encode(); lg('flipped child=%s'%k)\n" +
    "            time.sleep(0.6)\n" +
    "            m[:]=(orig_hex+'\\n').encode(); lg('restored')\n" +
    "            sys.exit(0)\n" +
    "    time.sleep(0.00002)\n" +
    "lg('no diff child seen')\n";
  const child = spawn("python3", ["-c", script, refPath, cPrime, cOid, String(vpid), log], {
    stdio: "ignore",
  });
  child.unref();
  return child;
};

describe("CX-r35-C: window-mode ref flip on the judged read channel", () => {
  it(
    "verifierGit diff HEAD cannot serve a C'-shaped clean diff",
    { timeout: 300_000 },
    async () => {
      if (!HAS_MMAP) return;
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx35c-"));
        tmpdirs.push(root);
        try {
          execFileSync("git", ["init", "-q", "-b", "main", root]);
          git(root, ["config", "user.email", "t@t"]);
          git(root, ["config", "user.name", "t"]);
          writeFileSync(path.join(root, "f.txt"), "v1\n");
          git(root, ["add", "f.txt"]);
          git(root, ["commit", "-qm", "c1"]);
          const cOid = git(root, ["rev-parse", "refs/heads/main"]);
          // C': tree carries the dirty worktree bytes — `diff HEAD`
          // against it reports f.txt clean.
          writeFileSync(path.join(root, "f.txt"), "DIRTY-SECRET\n");
          const tmpIdx = path.join(root, ".git", "cx35-tmpindex");
          execFileSync("cp", [path.join(root, ".git", "index"), tmpIdx]);
          const env2 = { ...process.env, GIT_INDEX_FILE: tmpIdx };
          git(root, ["add", "f.txt"], env2);
          const tree2 = git(root, ["write-tree"], env2);
          const cPrime = git(root, ["commit-tree", tree2, "-p", cOid, "-m", "forged"], {
            ...env2,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          });
          const refPath = path.join(root, ".git", "refs", "heads", "main");
          const log = path.join(os.tmpdir(), `cx35c-${attempt}.log`);
          const hijack = startWindowFlip(refPath, cPrime, cOid, process.pid, log);
          await new Promise((r) => setTimeout(r, 250));
          let r;
          try {
            r = await verifierGit(root, ["diff", "--name-only", "-z", "HEAD"]);
          } catch {
            r = { exitCode: -1, stdout: "", stderr: "" };
          } finally {
            hijack.kill("SIGKILL");
          }
          if (r.exitCode === -1) refused++;
          else if (r.stdout.length === 0) forged++;
          else if (r.stdout.includes("f.txt")) honest++;
        } finally {
          /* tmpdirs cleanup */
        }
      }
      console.log(
        `cx35c window-mode ref flip on verifierGit diff HEAD: forged=${forged} refused=${refused} honest=${honest}`,
      );
      expect(forged).toBe(0);
      expect(refused + honest).toBe(8);
    },
  );
});
