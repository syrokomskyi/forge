/*
RFC-1616 round-33 independent adversarial probes — candidate commit
f38db06ae, exported tree.

CX-r33-D — `unprovenIgnoredPaths` calls
`enumerateTrackedRuleSources` (:5531) BEFORE
`armEvidenceWindowWatch` (:5533) — by design, so the claims-
enumerated `.gitignore` paths join the pin+event set at arm time.
But that spawn's claims-fd re-proof (`evidenceSpawnState` :4443)
runs in an UNARMED window: no `/proc/self/fd` inotify is armed yet,
so a `/proc/<vpid>/fd/N` pwrite between the re-proof's last byte
and the `ls-files -z -- *.gitignore` child's own open+read serves
a forged claims enumeration, and a restore before the arm leaves
no armed event and passes `claimsFdPin` at settle (:3824-3837).

The comment at :5555-5558 states the intended invariant — "A
`.gitignore` plant is never tracked, so its `!!`s can never be
proven by construction". The forged enumeration breaks it:

  1. Plant UNTRACKED `x/.gitignore` = "hidden\n" plus payload
     `x/hidden`. The `!! x/hidden` claim's provenance is under test.
  2. Forge a claims image = the minted claims index PLUS a sorted
     stage-0 `x/.gitignore` entry. The verifier's claims fd carries
     it for exactly the `ls-files -- *.gitignore` child's read.
  3. `armedSrc`/`trackedSet` now contain `x/.gitignore` — its bytes
     exist on disk so `existsSync` (:4460) admits it and the arm
     pins it (:5533, harmless — it never changes).
  4. `check-ignore -v` cites `x/.gitignore` for `x/hidden` (untracked
     .gitignore files DO apply); `trackedSet.has` passes.
  5. `diff --name-only HEAD` runs on the RESTORED claims index —
     `x/.gitignore` is absent from claims and absent from HEAD, and
     an untracked file is never in a HEAD-vs-index name-only diff —
     so `dirtySrc` misses the cite source.
  6. `x/hidden` is PROVEN ignored → the returned Set omits it —
     a forged `!!` provenance attesting foreign rule bytes.

Honest outcomes: refused = `null`; honest = Set containing
"x/hidden"; forged = returned Set WITHOUT "x/hidden".

Test 2 applies the identical flip to `enumerateTrackedRuleSources`'s
other caller — `evidenceAnchoredGit(add)`'s `:5070` enumeration —
where the forged set lands in `ruleSources`, gated by
`provenSource` (:4953-4956): `pinned` covers only caller-provided
`extraWatchPaths`, and the `ruleSources` disjunct also requires
`clean.has(src)` — a claims-index `status` child inside the armed
window. A forged enumeration satisfies `ruleSources` but the
planted name is absent from `trackedAll`/`clean`, so the conjunct
refuses — expected 30/30 refused (the `add` path's conjunction is
what `unprovenIgnoredPaths`'s single `trackedSet` gate lacks).

Fix: the `*.gitignore` enumeration no longer spawns on the claims fd
at all — `prepareEvidenceIndex` retains the parsed claim names on
`EvidenceIndex.names` (attested by the same claims byte-pin the spawn
was re-proving against) and `enumerateTrackedRuleSources` filters
them in-process. Deleting the unarmed spawn deletes the
re-proof→spawn window rather than narrowing it.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  unprovenIgnoredPaths,
} from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/** Insert a stage-0 entry into a DIRC v2 image (sorted by name),
 * re-seal the trailer checksum. */
function addIndexEntry(indexBytes: Buffer, name: string, blobOid: Buffer): Buffer {
  const n = indexBytes.readUInt32BE(8);
  const nameBuf = Buffer.from(name, "utf8");
  const entry = Buffer.alloc(Math.ceil((62 + nameBuf.length + 1) / 8) * 8);
  entry.writeUInt32BE(0o100644, 24); // mode in stat block
  blobOid.copy(entry, 40);
  entry.writeUInt16BE(Math.min(nameBuf.length, 0xfff), 60);
  nameBuf.copy(entry, 62);
  const entries: { name: Buffer; off: number; esz: number }[] = [];
  let off = 12;
  for (let i = 0; i < n; i++) {
    const nlen = indexBytes.readUInt16BE(off + 60) & 0xfff;
    entries.push({
      name: Buffer.from(indexBytes.subarray(off + 62, off + 62 + nlen)),
      off,
      esz: Math.ceil((62 + nlen + 1) / 8) * 8,
    });
    off += entries[entries.length - 1]!.esz;
  }
  const tail = indexBytes.subarray(off, indexBytes.length - 20); // extensions
  let ins = entries.length;
  for (let i = 0; i < entries.length; i++) {
    if (Buffer.compare(entries[i]!.name, nameBuf) > 0) {
      ins = i;
      break;
    }
  }
  const parts: Buffer[] = [];
  const head = Buffer.from(indexBytes.subarray(0, 12));
  head.writeUInt32BE(n + 1, 8);
  parts.push(head);
  for (let i = 0; i <= entries.length; i++) {
    if (i === ins) parts.push(entry);
    if (i < entries.length) {
      const e = entries[i]!;
      parts.push(Buffer.from(indexBytes.subarray(e.off, e.off + e.esz)));
    }
  }
  parts.push(Buffer.from(tail));
  const body = Buffer.concat(parts);
  const digest = createHash("sha1").update(body).digest();
  return Buffer.concat([body, digest]);
}

/**
 * Flip the claims fd for the lifetime of the
 * `ls-files -z -- *.gitignore` child (the PRE-arm
 * `enumerateTrackedRuleSources` consult), restoring while the
 * verifier is still frozen — before `armEvidenceWindowWatch` arms
 * the fd watch.
 */
const startPreArmFlip = (vpid: number, imgPath: string, secs = 60, logPath?: string) => {
  const script =
    "import os,sys,time\n" +
    "vpid=int(sys.argv[1]); img=sys.argv[2]; end=time.time()+float(sys.argv[3]); log=open(sys.argv[4],'a')\n" +
    "me=str(os.getpid()); orig=None; tino=None; done=False; t0=time.time()\n" +
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
    "            return (f,n,os.fstat(f).st_ino)\n" +
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
    "forged=open(img,'rb').read()\n" +
    "while time.time()<end and not done:\n" +
    "    for k in kids():\n" +
    "        if k==me: continue\n" +
    "        av=argv(k)\n" +
    "        if b'ls-files' in av and b'*.gitignore' in av:\n" +
    "            try: os.kill(int(k),19)\n" +
    "            except: continue\n" +
    "            try: os.kill(vpid,19)\n" +
    "            except: pass\n" +
    "            hit=findfd()\n" +
    "            if hit is not None:\n" +
    "                f,n,ino=hit\n" +
    "                try:\n" +
    "                    orig=os.pread(f,os.fstat(f).st_size,0)\n" +
    "                    os.pwrite(f,forged,0); os.ftruncate(f,len(forged))\n" +
    "                    tino=ino; lg('flipped fd=%s child=%s'%(n,k))\n" +
    "                except Exception as e: lg('fliperr %s'%e)\n" +
    "                try: os.close(f)\n" +
    "                except: pass\n" +
    "            # let the child run (verifier stays frozen), then\n" +
    "            # restore BEFORE it can arm the fd watch\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "            for _ in range(60000):\n" +
    "                try:\n" +
    "                    stt=open('/proc/%s/stat'%k).read().rsplit(')',1)[1].split()[0]\n" +
    "                    if stt=='Z': break\n" +
    "                except: break\n" +
    "                time.sleep(0.00005)\n" +
    "            if tino is not None and orig is not None:\n" +
    "                hit=findino(tino)\n" +
    "                if hit is not None:\n" +
    "                    try:\n" +
    "                        f,n=hit\n" +
    "                        os.pwrite(f,orig,0); os.ftruncate(f,len(orig)); os.close(f)\n" +
    "                        lg('restored fd=%s'%n)\n" +
    "                    except Exception as e: lg('restoreerr %s'%e)\n" +
    "            try: os.kill(vpid,18)\n" +
    "            except: pass\n" +
    "            done=True\n" +
    "    time.sleep(0.00002)\n" +
    "lg('exit done=%s'%(done,))\n";
  const child = spawn(
    "python3",
    ["-c", script, String(vpid), imgPath, String(secs), logPath ?? "/tmp/cx33d-trace.txt"],
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

describe("CX-r33-D: pre-arm claims-fd flip forges the tracked-source set — planted .gitignore attests foreign rules", () => {
  it(
    "forged `ls-files -- *.gitignore` adds a planted source to trackedSet — `!!` proven via foreign bytes",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx33d-"));
        tmpdirs.push(root);
        execFileSync("git", ["init", "-q", "-b", "main", root]);
        git(root, ["config", "user.email", "t@t"]);
        git(root, ["config", "user.name", "t"]);
        writeFileSync(path.join(root, ".gitignore"), "visible\n");
        writeFileSync(path.join(root, "f.txt"), "v1\n");
        git(root, ["add", ".gitignore", "f.txt"]);
        git(root, ["commit", "-qm", "c1"]);
        // Planted UNTRACKED rule source + payload under it.
        execFileSync("mkdir", ["-p", path.join(root, "x")]);
        writeFileSync(path.join(root, "x", ".gitignore"), "hidden\n");
        writeFileSync(path.join(root, "x", "hidden"), "x\n");
        writeFileSync(path.join(root, "visible"), "y\n");
        // Forged claims image = minted claims (≈ real index here)
        // PLUS a stage-0 x/.gitignore entry.
        const blobOid = Buffer.from(git(root, ["hash-object", "-w", "--stdin"], "hidden\n"), "hex");
        const forgedImg = addIndexEntry(
          readFileSync(path.join(root, ".git", "index")),
          "x/.gitignore",
          blobOid,
        );
        const img = path.join(os.tmpdir(), `cx33d-img-${process.pid}-${attempt}`);
        writeFileSync(img, forgedImg);
        const hijack = startPreArmFlip(process.pid, img);
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
        `pre-arm claims-fd flip (unprovenIgnoredPaths trackedSet): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );

  it(
    "same flip at evidenceAnchoredGit's :5070 enumeration — planted source joins `pinned`, `provenSource` short-circuits the residual drop",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx33d2-"));
        tmpdirs.push(root);
        execFileSync("git", ["init", "-q", "-b", "main", root]);
        git(root, ["config", "user.email", "t@t"]);
        git(root, ["config", "user.name", "t"]);
        writeFileSync(path.join(root, ".gitignore"), "visible\n");
        writeFileSync(path.join(root, "f.txt"), "v1\n");
        git(root, ["add", ".gitignore", "f.txt"]);
        git(root, ["commit", "-qm", "c1"]);
        execFileSync("mkdir", ["-p", path.join(root, "x")]);
        writeFileSync(path.join(root, "x", ".gitignore"), "hidden\n");
        writeFileSync(path.join(root, "x", "hidden"), "x\n");
        writeFileSync(path.join(root, "visible"), "y\n");
        const blobOid = Buffer.from(git(root, ["hash-object", "-w", "--stdin"], "hidden\n"), "hex");
        const forgedImg = addIndexEntry(
          readFileSync(path.join(root, ".git", "index")),
          "x/.gitignore",
          blobOid,
        );
        const img = path.join(os.tmpdir(), `cx33d2-img-${process.pid}-${attempt}`);
        writeFileSync(img, forgedImg);
        const hijack = startPreArmFlip(process.pid, img);
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
        `pre-arm claims-fd flip (anchored add pinned-set): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );
});
