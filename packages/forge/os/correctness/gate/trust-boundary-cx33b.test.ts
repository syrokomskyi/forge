/*
RFC-1616 round-33 independent adversarial probes — candidate commit
f38db06ae, exported tree.

CX-r33-B — `verifyAnchoredMutationCoverage`'s `runLive` fd-form
per-spawn re-proof (verifier-git.ts:4608-4637) re-reads the frozen
post-op liveIndex on a FRESH `/dev/fd` description, compares it to
`liveIndex.bytes`, then `spawnCaptured` hands the dup'd description to
the child as fd 3. Between the re-proof's last byte and the child's
own `GIT_INDEX_FILE=/dev/fd/3` open+map there is a same-UID window no
guard covers: the liveIndex fd is NOT part of `evidenceWindowFiles`
(:3557-3570 — only `preflight.index` is watched), so a
`/proc/<vpid>/fd/N` pwrite fires no armed event; the only byte checks
are the pre-spawn re-proof and `finish()`'s readback (:4700-4715).
A flip strictly inside ONE coverage child's lifetime slips both —
r32 added the per-spawn re-proof but the re-proof→spawn gap was never
closed.

Attack shape (CX-r29-C's staged-set forgery re-landed through the fd
re-proof→spawn gap):

  1. Freeze the anchored `add -A -- .` child on first /proc sight;
     freeze the verifier; inject a foreign stage `x/evil.txt` via
     `update-index --cacheinfo` (retrying through the op's index.lock
     window so the entry lands in the post-op index before the
     verifier's indexPin/snapshot); release both.
  2. The verifier copies the real index into the O_TMPFILE liveIndex
     — the foreign entry is inside the judged snapshot, but
     `update-index --cacheinfo` staged a blob the worktree never had,
     so honest coverage would refuse (`diff` index-vs-worktree drift).
  3. The hijacker spots the first coverage child (`ls-files -s`),
     SIGSTOPs it pre-index-read, pwrites a forged image (the same
     index MINUS `x/evil.txt`, derived by stripping the entry from
     the snapshot bytes and re-sealing the trailer) into the
     liveIndex fd, SIGCONTs it.
  4. `liveMap` ≡ forged → `changed` never contains `x/evil.txt` →
     the drift check is never consulted for it → coverage passes.
  5. On the child's exit the hijacker freezes the verifier, restores
     the original liveIndex bytes so `finish()`'s readback attests
     the untouched snapshot, and resumes.

Honest outcomes: refused = exitCode -1 (EVIDENCE-REFUSED); honest =
foreign stage absent/clobbered mid-op or coverage exits non-zero;
forged = `add` exits 0 while `x/evil.txt` remains staged at the
attacker blob in the REAL `.git/index`.

Fix: the fd-form liveIndex now arms a dedicated `fsWatch` on
`/proc/self/fd/<fd>` for the whole coverage window — a pwrite through
any same-UID descriptor fires `change` at write time and sets
`liveIndexDirty`, so a restore before `finish()`'s readback can no
longer launder the event; `finish()` refuses on the flag alongside
the byte compare. A liveIndex fd the watch cannot arm refuses up
front rather than running unobserved.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evidenceAnchoredGit, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";

// This Node build omits `O_TMPFILE` from `fs.constants` even though the
// kernel supports it — the production fd-form liveIndex branch
// (:4579-4588) is the one this probe exercises (cx32b convention).
(fsConstants as { O_TMPFILE?: number }).O_TMPFILE = 0o20200000;

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx33b-"));
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
 * One python helper owns every signal (cx32b convention — separate
 * helpers' freezes interleave):
 *  phase 1 — on the `git add` child: freeze the verifier, retry the
 *    `update-index --cacheinfo` injection for a bounded window (a
 *    landing before the op's index write can be clobbered by it;
 *    persistent retries guarantee a post-write landing), unfreeze.
 *  phase 2 — on the FIRST `ls-files -s` child (liveR coverage
 *    enumeration — the claims `ls-files -s` runs SECOND and reads
 *    the claims fd, not liveIndex): freeze it and the verifier,
 *    strip `x/evil.txt` from the liveIndex image and pwrite it back,
 *    unfreeze both; on the child's exit freeze the verifier again,
 *    restore the original bytes, unfreeze.
 */
const startHijacker = (vpid: number, injectCmd: string, secs = 90, logPath?: string) => {
  const script =
    "import os,sys,time,struct,hashlib\n" +
    "vpid=int(sys.argv[1]); cmd=sys.argv[2]; mark=b'x/evil.txt'; end=time.time()+float(sys.argv[3]); log=open(sys.argv[4],'a')\n" +
    "me=str(os.getpid()); seen=set(); injected=False; flipped=False; restored=False; orig=None; tino=None; t0=time.time()\n" +
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
    "def strip(body):\n" +
    "    n=struct.unpack('>I',body[8:12])[0]; off=12\n" +
    "    for i in range(n):\n" +
    "        nlen=struct.unpack('>H',body[off+60:off+62])[0]&0xFFF\n" +
    "        name=body[off+62:off+62+nlen]; esz=(62+nlen+8)//8*8\n" +
    "        if name==mark:\n" +
    "            b=bytearray(body[:-20] if len(body)>=20 else body)\n" +
    "            struct.pack_into('>I',b,8,n-1)\n" +
    "            nb=bytes(b[:off])+bytes(b[off+esz:])\n" +
    "            return nb+hashlib.sha1(nb).digest()\n" +
    "        off+=esz\n" +
    "    return body\n" +
    "def findfd(wantmark):\n" +
    "    try: names=os.listdir('/proc/%s/fd'%vpid)\n" +
    "    except: return None\n" +
    "    for n in names:\n" +
    "        try:\n" +
    "            if '(deleted)' not in os.readlink('/proc/%s/fd/%s'%(vpid,n)): continue\n" +
    "            f=os.open('/proc/%s/fd/%s'%(vpid,n), os.O_RDWR)\n" +
    "        except: continue\n" +
    "        try:\n" +
    "            if os.pread(f,4,0)!=b'DIRC': os.close(f); continue\n" +
    "            if wantmark:\n" +
    "                sz=os.fstat(f).st_size\n" +
    "                if mark in os.pread(f,sz,0): return (f,n,os.fstat(f).st_ino)\n" +
    "            else:\n" +
    "                return (f,n,os.fstat(f).st_ino)\n" +
    "            os.close(f)\n" +
    "        except: continue\n" +
    "    return None\n" +
    "def findino(ino):\n" +
    "    try: names=os.listdir('/proc/%s/fd'%vpid)\n" +
    "    except: return None\n" +
    "    for n in names:\n" +
    "        try:\n" +
    "            f=os.open('/proc/%s/fd/%s'%(vpid,n), os.O_RDWR)\n" +
    "            if os.fstat(f).st_ino==ino: return (f,n)\n" +
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
    "                hit=findfd(True)\n" +
    "                if hit is not None:\n" +
    "                    f,n,ino=hit\n" +
    "                    try:\n" +
    "                        orig=os.pread(f,os.fstat(f).st_size,0)\n" +
    "                        img=strip(orig)\n" +
    "                        os.pwrite(f,img,0); os.ftruncate(f,len(img))\n" +
    "                        tino=ino; flipped=True; lg('flipped fd=%s child=%s'%(n,k))\n" +
    "                    except Exception as e: lg('fliperr %s'%e)\n" +
    "                    try: os.close(f)\n" +
    "                    except: pass\n" +
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
    "                    hit=findino(tino)\n" +
    "                    if hit is not None:\n" +
    "                        try:\n" +
    "                            f,n=hit\n" +
    "                            os.pwrite(f,orig,0); os.ftruncate(f,len(orig)); os.close(f)\n" +
    "                            restored=True; lg('restored fd=%s'%n)\n" +
    "                        except Exception as e: lg('restoreerr %s'%e)\n" +
    "                    try: os.kill(vpid,18)\n" +
    "                    except: pass\n" +
    "                break\n" +
    "        time.sleep(0.00002)\n" +
    "    else:\n" +
    "        time.sleep(0.0001)\n" +
    "lg('exit injected=%s flipped=%s restored=%s'%(injected,flipped,restored))\n";
  const child = spawn(
    "python3",
    ["-c", script, String(vpid), injectCmd, String(secs), logPath ?? "/tmp/cx33b-trace.txt"],
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

describe("CX-r33-B: liveIndex fd re-proof→spawn flip launders a foreign stage past staged-set coverage", () => {
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
        const foreign = git(root, ["hash-object", "-w", "--stdin"], "FORGED\n");
        const hijack = startHijacker(
          process.pid,
          `git -C '${root}' update-index --add --cacheinfo 100644,${foreign},x/evil.txt`,
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
        `liveIndex flip on ls-files -s (anchored add): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
