/*
RFC-1616 round-34 adversarial probes — candidate commit 0245bf867,
exported tree.

CX-r34-A — the `fsWatch(/proc/self/fd/<fd>)` guard added for CX-r33-B
fires on inotify `change`, but an `mmap(MAP_SHARED)` memory store
through `/proc/<vpid>/fd/N` generates NO inotify event at all. The
liveIndex fd-form's only other guards are `finish()`'s byte compare
(defeated by restoring through the same mapping) and size (defeated
by forging a same-length image). ctime is kernel-managed and cannot
be rewound — but the fd-form pinned no stat at all, so a flip→restore
strictly inside one coverage child's lifetime was invisible to every
layer.

Attack shape (CX-r33-B re-landed through the inotify blind spot):

  1. Freeze the anchored `add -A -- .` child; inject the foreign
     stage `x/evil.txt` via `update-index --cacheinfo` through the
     op's index.lock window so it lands in the judged post-op index.
  2. On the first coverage child (`ls-files -s`), SIGSTOP it,
     freeze the verifier, open the liveIndex fd via
     `/proc/<vpid>/fd`, `mmap(MAP_SHARED)` it, and store a forged
     image: the same index MINUS `x/evil.txt` — the entry slot is
     replaced by an equal-size ignorable index extension (4-byte
     signature + length + filler), the entry count decremented and
     the SHA trailer re-sealed, so the image is the SAME length and
     no ftruncate (which WOULD fire inotify) is needed.
  3. `liveMap` ≡ forged → `changed` never contains `x/evil.txt` →
     coverage passes → `add` exits 0 with the foreign stage real.
  4. On the child's exit, freeze the verifier and store the ORIGINAL
     bytes back through the same mapping — never msync, so the dirty
     pages linger in page cache and (on kernels deferring the
     timestamp to writeback) the change time stays untouched too.

Honest outcomes: refused = exitCode -1 (EVIDENCE-REFUSED); honest =
foreign stage absent/clobbered mid-op or coverage exits non-zero;
forged = `add` exits 0 while `x/evil.txt` remains staged at the
attacker blob in the REAL `.git/index`.

Fix: the fd-form liveIndex pins `fstatSync(fd, {bigint}).ctimeNs` at
mint and `finish()` runs `fsyncSync(fd)` before the settle stat —
the sync forces writeback of mmap-dirtied pages, so a deferred
timestamp update lands inside the check; any store — syscall or
memory — leaves the change time bumped, and bytes/size/the armed
watch cover the syscall paths. The claims-fd settle pins the same
tuple (CX-r34-B).
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evidenceAnchoredGit, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";

// This Node build omits `O_TMPFILE` from `fs.constants` even though the
// kernel supports it — the production fd-form liveIndex branch
// (:4581-4600) is the one this probe exercises (cx33b convention).
(fsConstants as { O_TMPFILE?: number }).O_TMPFILE = 0o20200000;

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;
const HAS_MMAP = HAS_PY && spawnSync("python3", ["-c", "import mmap"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx34a-"));
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
 * One python helper owns every signal (cx33b convention). The write
 * path differs: the liveIndex fd is `mmap`'d MAP_SHARED once, and
 * both the forged store and the restore go through the mapping —
 * memory stores generate no inotify event and need no ftruncate
 * because the forged image replaces the evil entry slot with an
 * equal-size ignorable extension block, keeping total length (and
 * therefore the SHA trailer offset) identical.
 */
const startHijacker = (vpid: number, injectCmd: string, secs = 90, logPath?: string) => {
  const script =
    "import os,sys,time,struct,hashlib,mmap\n" +
    "vpid=int(sys.argv[1]); cmd=sys.argv[2]; mark=b'x/evil.txt'; end=time.time()+float(sys.argv[3]); log=open(sys.argv[4],'a')\n" +
    "me=str(os.getpid()); seen=set(); injected=False; flipped=False; restored=False; orig=None; tino=None; mm=None; t0=time.time()\n" +
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
    "def swap(body):\n" +
    "    n=struct.unpack('>I',body[8:12])[0]; off=12\n" +
    "    for i in range(n):\n" +
    "        nlen=struct.unpack('>H',body[off+60:off+62])[0]&0xFFF\n" +
    "        name=body[off+62:off+62+nlen]; esz=(62+nlen+8)//8*8\n" +
    "        if name==mark:\n" +
    "            b=bytearray(body[:-20] if len(body)>=20 else body)\n" +
    "            struct.pack_into('>I',b,8,n-1)\n" +
    "            ext=b'ZZZZ'+struct.pack('>I',esz-8)+b'\\0'*(esz-8)\n" +
    "            nb=bytes(b[:off])+ext+bytes(b[off+esz:])\n" +
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
    "                        sz=os.fstat(f).st_size\n" +
    "                        orig=os.pread(f,sz,0)\n" +
    "                        img=swap(orig)\n" +
    "                        mm=mmap.mmap(f,0,access=mmap.ACCESS_WRITE)\n" +
    "                        mm[0:len(img)]=img\n" +
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
    "                            if mm is None: mm=mmap.mmap(f,0,access=mmap.ACCESS_WRITE)\n" +
    "                            mm[0:len(orig)]=orig; os.close(f)\n" +
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
    ["-c", script, String(vpid), injectCmd, String(secs), logPath ?? "/tmp/cx34a-trace.txt"],
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

describe("CX-r34-A: mmap MAP_SHARED flip→restore on the liveIndex fd dodges the armed watch", () => {
  it(
    "mmap-forged liveIndex during `ls-files -s` hides the foreign stage — anchored `add` exits 0 with it staged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_MMAP) return ctx.skip();
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
        `liveIndex mmap flip on ls-files -s (anchored add): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
