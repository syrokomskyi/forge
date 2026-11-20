/*
RFC-1616 round-34 adversarial probes — candidate commit 0245bf867,
exported tree.

CX-r34-B — the claims fd's armed `/proc/self/fd` watch (CX-r22-D,
re-confirmed refused 30/30 by cx33a) sees syscall writes — `pwrite`,
`ftruncate`, `mmap` does not apply — but a `mmap(MAP_SHARED)` memory
store through `/proc/<vpid>/fd/N` generates NO inotify event. The
`claimsFdPin` settle compared only size+bytes, so a stat-forged
claims image flipped onto the fd for the lifetime of ONE
`diff --name-only -z HEAD` child — then restored through the same
mapping — slipped both layers. The forged image is same-length
(CX-121's stat-tuple shape: `.gitignore` entry carries the HEAD blob
oid plus the live worktree stat), so no truncate is needed at all.

Attack shape (CX-r33-A re-landed through the inotify blind spot):

  1. Committed `.gitignore` = "visible\n"; worktree rewrite =
     "hidden\nvisible\n" (foreign bytes, dirty vs HEAD); untracked
     `hidden` produces the `!!` claim under test.
  2. On the `diff` child's /proc sight: SIGSTOP it, freeze the
     verifier, mmap the claims fd MAP_SHARED, store the forged
     same-length image, SIGCONT.
  3. `diff` reads the forged index → `.gitignore` clean → `hidden`
     judged PROVEN → `unprovenIgnoredPaths` returns a Set omitting
     it (a forged `!!` verdict — statusDirty drops it from entries).
  4. On `diff` exit, freeze the verifier, store the original bytes
     back through the same mapping — the claims fd never saw an
     inotify event and the settle byte compare attests the restore.

Honest outcomes: refused = `null` (or thrown unverifiable at the
`statusDirty` level); honest = a Set containing "hidden"; forged =
a returned Set WITHOUT "hidden".

Fix: `claimsFdPin` now pins `fstatSync(fd, {bigint}).ctimeNs`
alongside bytes — `mmap` stores bump the inode's change time
(eagerly on tmpfs, at writeback elsewhere — the settle `fsyncSync`
flushes dirty pages first so a deferred update lands inside the
check). The memory-store path cannot rewind the timestamp.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unprovenIgnoredPaths } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;
const HAS_MMAP = HAS_PY && spawnSync("python3", ["-c", "import mmap"]).status === 0;

/**
 * cx33a's flip hijacker with the write path swapped to mmap — and
 * the forged image built IN PLACE from the fd's own bytes: the
 * claims image is `serializeIndexClaims`' rebuild (zero-stat), not
 * `.git/index`, so a prebuilt file could not promise equal length.
 * The helper patches the `.gitignore` entry's 40-byte stat field to
 * the live worktree tuple and re-seals the trailer — same length by
 * construction — then stores via `mmap(MAP_SHARED)` only: no
 * `pwrite`, no `ftruncate`, no inotify event.
 */
const startClaimsFdMmapFlip = (vpid: number, wtFile: string, secs = 60, logPath?: string) => {
  const script =
    "import os,sys,time,struct,hashlib,mmap\n" +
    "vpid=int(sys.argv[1]); wt=sys.argv[2]; mark=b'.gitignore'; end=time.time()+float(sys.argv[3]); log=open(sys.argv[4],'a')\n" +
    "me=str(os.getpid()); seen=set(); retries={}; orig=None; tgt=None; mm=None; done=False; t0=time.time()\n" +
    "def lg(m): log.write('%.1f %s\\n'%((time.time()-t0)*1000,m)); log.flush()\n" +
    "def kids():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
    "            try: out += open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return out\n" +
    "def findfd():\n" +
    "    try: names=os.listdir('/proc/%s/fd'%vpid)\n" +
    "    except: return None\n" +
    "    for n in names:\n" +
    "        try:\n" +
    "            if '(deleted)' not in os.readlink('/proc/%s/fd/%s'%(vpid,n)): continue\n" +
    "            f=os.open('/proc/%s/fd/%s'%(vpid,n), os.O_RDWR)\n" +
    "        except: continue\n" +
    "        try:\n" +
    "            if os.pread(f,4,0)!=b'DIRC': os.close(f); continue\n" +
    "            return (f,n)\n" +
    "        except: continue\n" +
    "    return None\n" +
    "def forge(body):\n" +
    "    st=os.stat(wt)\n" +
    "    n=struct.unpack('>I',body[8:12])[0]; off=12\n" +
    "    b=bytearray(body)\n" +
    "    for i in range(n):\n" +
    "        nlen=struct.unpack('>H',b[off+60:off+62])[0]&0xFFF\n" +
    "        name=bytes(b[off+62:off+62+nlen]); esz=(62+nlen+8)//8*8\n" +
    "        if name==mark:\n" +
    "            mode=struct.unpack('>I',b[off+24:off+28])[0]\n" +
    "            sf=struct.pack('>10I',st.st_ctime_ns//10**9,st.st_ctime_ns%10**9,st.st_mtime_ns//10**9,st.st_mtime_ns%10**9,st.st_dev&0xFFFFFFFF,st.st_ino&0xFFFFFFFF,mode,st.st_uid&0xFFFFFFFF,st.st_gid&0xFFFFFFFF,st.st_size&0xFFFFFFFF)\n" +
    "            b[off:off+40]=sf\n" +
    "            nb=bytes(b[:-20])\n" +
    "            return nb+hashlib.sha1(nb).digest()\n" +
    "        off+=esz\n" +
    "    return body\n" +
    "while time.time()<end and not done:\n" +
    "    for k in kids():\n" +
    "        if k in seen or k==me: continue\n" +
    "        try: av=open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
    "        except: av=[]\n" +
    "        a0=av[0] if av else b''\n" +
    "        ambig=(a0==b'' or a0.endswith(b'/node') or a0==b'node' or a0.endswith(b'/python3'))\n" +
    "        if b'diff' in av:\n" +
    "            try: os.kill(int(k),19)\n" +
    "            except: seen.add(k); continue\n" +
    "            try: os.kill(vpid,19)\n" +
    "            except: pass\n" +
    "            hit=findfd()\n" +
    "            if hit is not None:\n" +
    "                f,n=hit\n" +
    "                try:\n" +
    "                    sz=os.fstat(f).st_size\n" +
    "                    orig=os.pread(f,sz,0)\n" +
    "                    forged=forge(orig)\n" +
    "                    mm=mmap.mmap(f,0,access=mmap.ACCESS_WRITE)\n" +
    "                    mm[0:len(forged)]=forged\n" +
    "                    tgt=n; lg('flipped fd=%s child=%s'%(n,k))\n" +
    "                except Exception as e: lg('fliperr %s'%e)\n" +
    "                try: os.close(f)\n" +
    "                except: pass\n" +
    "            try: os.kill(vpid,18)\n" +
    "            except: pass\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "            for _ in range(60000):\n" +
    "                if not os.path.exists('/proc/%s'%k): break\n" +
    "                time.sleep(0.00005)\n" +
    "            if tgt is not None and orig is not None:\n" +
    "                try:\n" +
    "                    if mm is None:\n" +
    "                        f=os.open('/proc/%s/fd/%s'%(vpid,tgt), os.O_RDWR)\n" +
    "                        mm=mmap.mmap(f,0,access=mmap.ACCESS_WRITE)\n" +
    "                        os.close(f)\n" +
    "                    mm[0:len(orig)]=orig\n" +
    "                    lg('restored fd=%s'%tgt)\n" +
    "                except Exception as e: lg('restoreerr %s'%e)\n" +
    "            done=True\n" +
    "        elif a0 and not ambig:\n" +
    "            seen.add(k)\n" +
    "        else:\n" +
    "            nr=retries.get(k,0)+1; retries[k]=nr\n" +
    "            if nr>800: seen.add(k)\n" +
    "    time.sleep(0.00002)\n" +
    "lg('exit done=%s'%(done,))\n";
  const child = spawn(
    "python3",
    ["-c", script, String(vpid), wtFile, String(secs), logPath ?? "/tmp/cx34b-trace.txt"],
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

describe("CX-r34-B: mmap MAP_SHARED flip→restore on the claims fd dodges the armed watch", () => {
  it(
    "mmap-forged claims index during `diff --name-only HEAD` attests a dirty .gitignore — `!!` provenance forged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_MMAP) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx34b-"));
        tmpdirs.push(root);
        execFileSync("git", ["init", "-q", "-b", "main", root]);
        git(root, ["config", "user.email", "t@t"]);
        git(root, ["config", "user.name", "t"]);
        writeFileSync(path.join(root, ".gitignore"), "visible\n");
        git(root, ["add", ".gitignore"]);
        git(root, ["commit", "-qm", "c1"]);
        // Foreign rule bytes into the tracked `.gitignore` worktree
        // file — dirty vs HEAD, but still a claims-tracked cite.
        writeFileSync(path.join(root, ".gitignore"), "hidden\nvisible\n");
        writeFileSync(path.join(root, "hidden"), "x\n");
        writeFileSync(path.join(root, "visible"), "y\n");
        const hijack = startClaimsFdMmapFlip(process.pid, path.join(root, ".gitignore"));
        try {
          const r = await unprovenIgnoredPaths(root, ["hidden"]);
          if (r === null) {
            refused++;
          } else if (!r.has("hidden")) {
            forged++;
          } else {
            honest++;
          }
        } catch (e) {
          lastErr = String(e).slice(0, 140);
          refused++;
        } finally {
          hijack.stop();
        }
      }
      console.log(
        `claims-fd mmap flip on diff child (unprovenIgnoredPaths): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
