/*
RFC-1616 round-34 independent adversarial probe — candidate commit
0245bf867, exported tree.

CX-r34-D — event-delivery vs flag-read ordering on the liveIndex
fd watch. The armed `fsWatch("/proc/self/fd/<fd>")` records writes
by setting `liveIndexDirty` in a libuv-dispatched `change` callback;
`finish()` (:4702, :4734) reads the flag SYNCHRONOUSLY from the
coverage child's `close` continuation — unlike
`windowWatch.settle()` (:3822) it awaits NO macrotask drain before
reading the flag, and `liveIndexWatcher.close()` (:4737) runs
BEFORE the byte readback, so an inotify record still queued in the
kernel buffer when the verifier was SIGSTOP'd dies undelivered if
the child-close io-callback is dispatched first in the SIGCONT
poll batch.

Race shape:

  1. Inject `x/evil.txt` stage into the post-op index (cx34b phase 1).
  2. On the first `ls-files -s` child: SIGSTOP child + verifier;
     PWRITE (not mmap — this probe tests the armed event's own
     delivery) the same-size name+oid rewrite into the liveIndex fd;
     SIGCONT the child so it reads the forged image and exits while
     the verifier stays frozen (the `change` events queue in the
     kernel, undelivered); PWRITE the original image back; SIGCONT
     the verifier.
  3. The verifier's next libuv poll sees BOTH the queued inotify
     data and the child-exit processing in one batch — whichever is
     dispatched first decides: flag-first → refuse, close-first →
     `finish()` reads flag=false, `watcher.close()` discards the
     pending queue, byte-compare sees restored bytes → FORGED.

Same-size in-place rewrite as cx34b (x/evil.txt → zzzzzzzzzz@decoy
blob). 30 attempts, forged/refused/honest tallies.

Fix: the liveIndex fd is `fchmod`ed `0400` at mint — the attacker's
O_RDWR `/proc/<vpid>/fd` open is EACCES outright, so this probe's
hijacker preludes with `chmodat` on the proc-fd path (the owner's
only reopen) before each pwrite — that chmod is itself the armed
`change` event and bumps `i_ctime` into the `ctimeNs` settle pin,
so the flip→restore is refused whether or not the write lands.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evidenceAnchoredGit, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";

(fsConstants as { O_TMPFILE?: number }).O_TMPFILE = 0o20200000;

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx34d-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

const startHijacker = (
  vpid: number,
  injectCmd: string,
  decoyOidHex: string,
  secs = 90,
  logPath?: string,
) => {
  const script =
    "import os,sys,time,struct,hashlib\n" +
    "vpid=int(sys.argv[1]); cmd=sys.argv[2]; mark=b'x/evil.txt'; repl=b'zzzzzzzzzz'; doid=bytes.fromhex(sys.argv[3]); end=time.time()+float(sys.argv[4]); log=open(sys.argv[5],'a')\n" +
    "me=str(os.getpid()); injected=False; flipped=False; restored=False; orig=None; tino=None; t0=time.time()\n" +
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
    "            if mark in os.pread(f,sz,0): return (f,n,os.fstat(f).st_ino)\n" +
    "            os.close(f)\n" +
    "        except: continue\n" +
    "    return None\n" +
    "def findino(ino):\n" +
    "    try: names=os.listdir('/proc/%s/fd'%vpid)\n" +
    "    except: return None\n" +
    "    for n in names:\n" +
    "        try:\n" +
    "            if not os.path.isfile('/proc/%s/fd/%s'%(vpid,n)): continue\n" +
    "            os.chmod('/proc/%s/fd/%s'%(vpid,n),0o600)\n" +
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
    "                hit=findfd()\n" +
    "                if hit is not None:\n" +
    "                    f,n,ino=hit\n" +
    "                    try:\n" +
    "                        orig=os.pread(f,os.fstat(f).st_size,0)\n" +
    "                        img=rewrite(orig)\n" +
    "                        os.pwrite(f,img,0)\n" +
    "                        tino=ino; flipped=True; lg('flipped fd=%s child=%s'%(n,k))\n" +
    "                    except Exception as e: lg('fliperr %s'%e)\n" +
    "                    try: os.close(f)\n" +
    "                    except: pass\n" +
    "                # release ONLY the child — the verifier stays frozen so\n" +
    "                # the queued inotify record is undelivered when the\n" +
    "                # child exits; restore happens while it is still\n" +
    "                # frozen, then one SIGCONT decides the poll order.\n" +
    "                try: os.kill(int(k),18)\n" +
    "                except: pass\n" +
    "                if flipped:\n" +
    "                    for _ in range(120000):\n" +
    "                        try:\n" +
    "                            stt=open('/proc/%s/stat'%k).read().rsplit(')',1)[1].split()[0]\n" +
    "                            if stt=='Z': break\n" +
    "                        except: break\n" +
    "                        time.sleep(0.00005)\n" +
    "                    hit=findino(tino)\n" +
    "                    if hit is not None:\n" +
    "                        try:\n" +
    "                            f,n=hit\n" +
    "                            os.pwrite(f,orig,0); os.close(f)\n" +
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
    [
      "-c",
      script,
      String(vpid),
      injectCmd,
      decoyOidHex,
      String(secs),
      logPath ?? "/tmp/cx34d-trace.txt",
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

describe("CX-r34-D: pwrite flip→restore with the verifier frozen through child exit — does the queued `change` beat finish()'s flag read?", () => {
  it(
    "queued inotify event vs synchronous finish() — forged liveIndex survives when close dispatches first",
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
        writeFileSync(path.join(root, "zzzzzzzzzz"), "z\n");
        const decoyOid = git(root, ["hash-object", "-w", "--stdin"], "z\n");
        const foreign = git(root, ["hash-object", "-w", "--stdin"], "FORGED\n");
        const log = `/tmp/cx34d-trace-${attempt}.txt`;
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
        `liveIndex pwrite flip→restore under frozen verifier (race): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
