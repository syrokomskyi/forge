/*
CX-r35-A (window shape): `refs/heads/main` is git-legit-writable
(0644), so it cannot ride the 0400 held-image gate — a same-UID
mmap(MAP_SHARED) flip→restore on the live path is silent to both the
armed inotify watch and every stat pin ({ino, ctime, size} unchanged
end to end). Under live-path consults `diff --name-only -z HEAD`
inside `unprovenIgnoredPaths`' window resolved HEAD→C' — a prebuilt
commit whose tree carries the modified rule-source bytes — so the
staged/dirty `x/.gitignore` read HEAD-clean and the payload `x/hidden`
was PROVEN ignored (omitted from the unproven set): a forged
successful verdict (r35-S1: forged 10/10).

The probe: a tracked `x/.gitignore` committed with `visible\n`, its
worktree bytes flipped to `hidden\n`, and a loose payload `x/hidden`.
Commit C' (same tree shape, `x/.gitignore` blob = the foreign bytes)
is planted in `objects/` as a legitimate object. A python helper
mmaps `refs/heads/main`, flips C→C' when the armed-window
`check-ignore` child appears, and restores when the `diff` child
exits — stat-silent on any filesystem.

Fix: consults no longer resolve refs through live paths — every
overlay-covered child reads the verifier-owned overlay gitdir minted
at arm (`GIT_DIR`=<captured copy>, `GIT_OBJECT_DIRECTORY`=real store,
`GIT_INDEX_FILE` explicit), so the C' flip can never reach a consult.
`fingerprint.consultBytes` pins each consultable `.git` file's bytes
at capture; the mint proves its copies equal the pin and the armed
window's settle re-proves each live source against what the mint saw
— a flip→restore in ANY ordering ends live≠minted (refused), a
mid-window flip the consult never saw ends honest.
*/
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unprovenIgnoredPaths } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;
const HAS_MMAP = HAS_PY && spawnSync("python3", ["-c", "import mmap"]).status === 0;

/**
 * mmap(MAP_SHARED) flip→restore on a writable .git file: prime a
 * writable mapping read-first (no fault, no ctime), flip when the
 * armed-window `check-ignore` child appears, restore after the `diff`
 * child exits. The consult window observes C at both stat pins and
 * endpoint bytes — only the consult channel itself could read C'.
 */
const startRefFlip = (refPath: string, cPrime: string, cOid: string, vpid: number) => {
  const script =
    "import os,sys,mmap,time\n" +
    "refpath,forged_hex,orig_hex,vpid,logpath=sys.argv[1:6]\n" +
    "forged=(forged_hex+'\\n').encode(); orig=(orig_hex+'\\n').encode()\n" +
    "log=open(logpath,'a'); t0=time.time()\n" +
    "def lg(m): log.write('%.1f %s\\n'%((time.time()-t0)*1000,m)); log.flush()\n" +
    "fd=os.open(refpath,os.O_RDWR); st0=os.fstat(fd)\n" +
    "m=mmap.mmap(fd,st0.st_size,mmap.MAP_SHARED,mmap.PROT_READ|mmap.PROT_WRITE)\n" +
    "_=m[0]; m[:]=orig\n" +
    "lg('armed-map ino=%d'%st0.st_ino)\n" +
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
    "end=time.time()+60; flipped=False; restored=False\n" +
    "while time.time()<end and not restored:\n" +
    "    for k in kids():\n" +
    "        av=argv(k)\n" +
    // `--stdin` belongs only to the judged consult's provenance
    // check-ignore — preflight's ignored-dirs consult also spawns
    // `check-ignore -z` children, which would flip pre-mint (the
    // overlay adopts the live bytes — the adopted-baseline class,
    // not the armed window this probe judges).
    "        if b'check-ignore' in av and b'--stdin' in av and not flipped:\n" +
    "            m[:]=forged; flipped=True\n" +
    "            lg('flipped on check-ignore child=%s'%k)\n" +
    "        if flipped and b'diff' in av:\n" +
    "            for _ in range(120000):\n" +
    "                try:\n" +
    "                    stt=open('/proc/%s/stat'%k).read().rsplit(')',1)[1].split()[0]\n" +
    "                    if stt=='Z': break\n" +
    "                except: break\n" +
    "                time.sleep(0.00005)\n" +
    "            m[:]=orig; restored=True\n" +
    "            lg('restored after diff child=%s'%k)\n" +
    "            break\n" +
    "    time.sleep(0.00002)\n" +
    "if not flipped:\n" +
    "    m[:]=forged; time.sleep(10); m[:]=orig; lg('fallback flip')\n" +
    "lg('exit final-bytes=%s'%m[:8])\n";
  const log = path.join(os.tmpdir(), `cx35a-${vpid}-${Math.random().toString(36).slice(2)}.log`);
  const child = spawn("python3", ["-c", script, refPath, cPrime, cOid, String(vpid), log], {
    stdio: "ignore",
  });
  child.unref();
  return { child, log };
};

describe("CX-r35-A: live-path ref mmap flip→restore inside an armed window", () => {
  it(
    "unprovenIgnoredPaths cannot be steered by a window-mode refs/heads/main flip",
    { timeout: 300_000 },
    async () => {
      if (!HAS_MMAP) return;
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx35a-"));
        tmpdirs.push(root);
        try {
          execFileSync("git", ["init", "-q", "-b", "main", root]);
          git(root, ["config", "user.email", "t@t"]);
          git(root, ["config", "user.name", "t"]);
          mkdirSync(path.join(root, "x"));
          writeFileSync(path.join(root, "x", ".gitignore"), "visible\n");
          writeFileSync(path.join(root, "f.txt"), "v1\n");
          writeFileSync(path.join(root, "x", "visible"), "y\n");
          git(root, ["add", "-A"]);
          git(root, ["commit", "-qm", "c1"]);
          const cOid = git(root, ["rev-parse", "refs/heads/main"]);
          // Foreign rule state + payload.
          writeFileSync(path.join(root, "x", ".gitignore"), "hidden\n");
          writeFileSync(path.join(root, "x", "hidden"), "x\n");
          // C': same tree, x/.gitignore blob = the modified bytes — a
          // `diff HEAD` against it reports the source HEAD-clean.
          const tmpIdx = path.join(root, ".git", "cx35-tmpindex");
          const env2 = { ...process.env, GIT_INDEX_FILE: tmpIdx };
          execFileSync("cp", [path.join(root, ".git", "index"), tmpIdx]);
          git(root, ["add", "x/.gitignore"], env2);
          const tree2 = git(root, ["write-tree"], env2);
          const cPrime = git(root, ["commit-tree", tree2, "-p", cOid, "-m", "forged"], {
            ...env2,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          });
          const refPath = path.join(root, ".git", "refs", "heads", "main");
          const hijack = startRefFlip(refPath, cPrime, cOid, process.pid);
          await new Promise((r) => setTimeout(r, 300));
          let r: Set<string> | null;
          try {
            r = await unprovenIgnoredPaths(root, ["x/hidden"]);
          } catch {
            r = null;
          } finally {
            hijack.child.kill("SIGKILL");
          }
          if (r === null) refused++;
          else if (!r.has("x/hidden")) forged++;
          else honest++;
        } finally {
          /* tmpdirs cleanup */
        }
      }
      console.log(
        `cx35a window-mode ref flip on unprovenIgnoredPaths: forged=${forged} refused=${refused} honest=${honest}`,
      );
      expect(forged).toBe(0);
      expect(refused + honest).toBe(10);
    },
  );
});
