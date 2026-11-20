/*
RFC-1616 round-33 independent adversarial probes — candidate commit
f38db06ae, exported tree.

CX-r33-A — the per-spawn claims-fd re-proof is not atomic with the
child's index read. `evidenceSpawnState` (verifier-git.ts:918-952)
opens `/dev/fd/<claimsFd>` on a FRESH description, reads+compares the
inode's bytes against `preflight.index.bytes`, then `spawnCaptured`
hands the dup'd description to the child as fd 3. Between the
re-proof's last `readSync` byte and the child's own
`GIT_INDEX_FILE=/dev/fd/3` open+map there is a same-UID window the
proof cannot see: a `/proc/<vpid>/fd/N` pwrite landing inside it
serves arbitrary index bytes to THIS spawn, and a restore before
`windowWatch.settle()`'s claimsFdPin readback (:3824-3837) erases the
evidence. `unprovenIgnoredPaths`'s `run()` (:5540-5553) mints this
state per consult child — the `diff --name-only -z HEAD` child is the
byte-binding that decides whether a cited `.gitignore` is committed-
clean (:5596-5600).

Attack shape (CX-121's forged stat tuple re-landed through the fd
re-proof→spawn gap):

  1. Committed `.gitignore` = "visible\n"; the worktree file is then
     rewritten "hidden\nvisible\n" — foreign bytes, dirty vs HEAD.
     An untracked `hidden` file produces the `!!` claim whose
     provenance is under test.
  2. Truth: `check-ignore` cites `.gitignore` (claims-tracked) but
     `diff --name-only HEAD` MUST report it dirty → `hidden` lands in
     `unproven`.
  3. The hijacker watches the /proc <vpid> children list; the instant
     the `diff` child appears it SIGSTOPs it (before its index open),
     pwrites a FORGED index (`.gitignore` entry = {HEAD blob oid +
     live worktree stat tuple}) into the verifier's claims fd, and
     SIGCONTs the child.
  4. `diff` reads the forged index → reports `.gitignore` clean →
     `dirtySrc` misses the cite source → `hidden` is PROVEN ignored
     → the returned Set omits it.
  5. On `diff` exit the hijacker restores the original claims bytes;
     the settle-time fd pin attests the restored state.

Honest outcomes: refused = `null`; honest = a Set containing
"hidden"; forged = a returned Set WITHOUT "hidden" (the `!!` claim
attested through a source whose live bytes are foreign).
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Build a `.git/index` image whose `path` entry carries the HEAD blob
 * oid plus the CURRENT worktree stat tuple — `diff`/`status` then trust
 * the stat and skip the content hash (CX-121's shape). Only valid for
 * v2-format indexes with a single stage-0 entry layout this repo makes.
 */
function forgeCleanIndex(root: string, file: string): Buffer {
  const idx = readFileSync(path.join(root, ".git", "index"));
  const n = idx.readUInt32BE(8);
  let off = 12;
  const b = Buffer.from(idx);
  for (let i = 0; i < n; i++) {
    const flags = b.readUInt16BE(off + 60);
    const nlen = flags & 0xfff;
    const name = b.subarray(off + 62, off + 62 + nlen).toString("utf8");
    const esz = Math.ceil((62 + nlen + 1) / 8) * 8;
    if (name === file) {
      const st = statSync(path.join(root, file), { bigint: true });
      const mode = b.readUInt32BE(off + 24);
      const stat = Buffer.alloc(40);
      stat.writeUInt32BE(Number(st.ctimeNs / 1_000_000_000n), 0);
      stat.writeUInt32BE(Number(st.ctimeNs % 1_000_000_000n), 4);
      stat.writeUInt32BE(Number(st.mtimeNs / 1_000_000_000n), 8);
      stat.writeUInt32BE(Number(st.mtimeNs % 1_000_000_000n), 12);
      stat.writeUInt32BE(Number(st.dev & 0xffffffffn), 16);
      stat.writeUInt32BE(Number(st.ino & 0xffffffffn), 20);
      stat.writeUInt32BE(mode, 24);
      stat.writeUInt32BE(Number(st.uid & 0xffffffffn), 28);
      stat.writeUInt32BE(Number(st.gid & 0xffffffffn), 32);
      stat.writeUInt32BE(Number(st.size & 0xffffffffn), 36);
      stat.copy(b, off);
    }
    off += esz;
  }
  const digest = createHash("sha1")
    .update(b.subarray(0, b.length - 20))
    .digest();
  digest.copy(b, b.length - 20);
  return b;
}

/**
 * Flip the verifier's claims fd to `imgPath` for the lifetime of ONE
 * `git diff` child, then restore the original bytes. The claims fd is
 * found by scanning /proc/<vpid>/fd for an unlinked DIRC image (the
 * O_TMPFILE or unlinked-held verifier index). Target child = cmdline
 * containing `diff`.
 */
const startClaimsFdFlip = (vpid: number, imgPath: string, secs = 60, logPath?: string) => {
  const script =
    "import os,sys,time\n" +
    "vpid=int(sys.argv[1]); img=sys.argv[2]; end=time.time()+float(sys.argv[3]); log=open(sys.argv[4],'a')\n" +
    "me=str(os.getpid()); seen=set(); retries={}; orig=None; tgt=None; done=False; t0=time.time()\n" +
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
    "forged=open(img,'rb').read()\n" +
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
    "                    orig=os.pread(f,os.fstat(f).st_size,0)\n" +
    "                    os.pwrite(f,forged,0); os.ftruncate(f,len(forged))\n" +
    "                    tgt=n; lg('flipped fd=%s child=%s'%(n,k))\n" +
    "                except Exception as e: lg('fliperr %s'%e)\n" +
    "                try: os.close(f)\n" +
    "                except: pass\n" +
    "            try: os.kill(vpid,18)\n" +
    "            except: pass\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "            # wait for the diff child to exit, then restore\n" +
    "            for _ in range(60000):\n" +
    "                if not os.path.exists('/proc/%s'%k): break\n" +
    "                time.sleep(0.00005)\n" +
    "            if tgt is not None and orig is not None:\n" +
    "                try:\n" +
    "                    f=os.open('/proc/%s/fd/%s'%(vpid,tgt), os.O_RDWR)\n" +
    "                    os.pwrite(f,orig,0); os.ftruncate(f,len(orig)); os.close(f)\n" +
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
    ["-c", script, String(vpid), imgPath, String(secs), logPath ?? "/tmp/cx33a-trace.txt"],
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

describe("CX-r33-A: claims-fd re-proof→spawn flip feeds a forged stat index to `unprovenIgnoredPaths`'s diff child", () => {
  it(
    "forged index during `diff --name-only HEAD` attests a dirty .gitignore — `!!` provenance forged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx33a-"));
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
        const img = path.join(os.tmpdir(), `cx33a-img-${process.pid}-${attempt}`);
        writeFileSync(img, forgeCleanIndex(root, ".gitignore"));
        const hijack = startClaimsFdFlip(process.pid, img);
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
        `claims-fd flip on diff child (unprovenIgnoredPaths): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
