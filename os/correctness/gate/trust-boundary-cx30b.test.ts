/*
RFC-1616 round-30 independent adversarial probes — candidate commit
027cf64e4, exported tree.

CX-r30-B — the frozen LIVE-index snapshot in
`verifyAnchoredMutationCoverage` is an O_TMPFILE fd that is NEVER
pinned. The claims fd got `claimsFdPin` (ino+ctimeMs re-stat at settle,
verifier-git.ts:3708-3716) after CX-r29-E proved `/proc/<pid>/fd`
pwrites land on same-UID O_TMPFILE inodes. The coverage snapshot gets
only `closeSync` in `finish()` (verifier-git.ts:4633-4638) — the
path-form fallback carries a stat-drift check, the fd form carries
nothing.

Attack shape (CX-r29-C re-opened on the fd side):

  1.  Freeze the anchored `add` child the instant it appears (same-UID
      /proc children + SIGSTOP, r29 convention) and inject a foreign
      stage `x/evil.txt` -> attacker blob into `.git/index` via
      `update-index --index-info`. Released, `add` merges and preserves
      the out-of-spec entry — the post-op REAL index carries the
      foreign stage, the armed watch ignores index writes by design,
      and the post-op indexPin attests it as baseline.
  2.  The verifier freezes those foreign bytes into the O_TMPFILE
      snapshot. A sibling pwrite through `/proc/<verifier-pid>/fd/<n>`
      swaps the inode's bytes to a prebuilt "honest post-add" index —
      `ls-files -s`, `diff`, `ls-files -o`, `check-ignore` children all
      re-open `/dev/fd/N` onto the same inode and never see the foreign
      entry: `changed` = {d/normal.txt} ⊆ covered, drift clean.
  3.  Exit 0 attests a staged set the real index does not hold — the
      foreign `x/evil.txt` stage persists and ships in the caller's
      next commit.

The residual note claims a snapshot pwrite yields claims-vs-snapshot
mismatch → refusal; that only covers a pwrite used to CREATE mismatch.
A pwrite that ALIGNS the snapshot with claims+op writes produces no
mismatch at all — it hides the foreign stage the claims-vs-live diff
exists to catch.

Fix: every frozen snapshot now pins BYTES, not inode stat — a same-UID
pwrite through `/proc/<pid>/fd/N` plus a ctime-restoring `utimensat`
slips an ino+ctime pin but cannot reproduce the snapshot content. The
live-index O_TMPFILE fd keeps the written buffer and re-reads it at
settle; the path-form scratch byte-compares alongside its stat pin;
the claims fd pin (same class, stat-only since CX-r29-E) is now a
readback compare too. `spawnCaptured` also tolerates a sparse stdin
(mock children lacking `.on`/`.end`) instead of crashing pre-finish.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evidenceAnchoredGit, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx30b-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/**
 * Snapshot scrub: polls BOTH forms of the coverage snapshot for a
 * DIRC image bearing `marker` (the foreign entry — present only in the
 * post-op live snapshot, never in the claims index).
 *
 * - fd-form (`O_TMPFILE`, never re-stat'd — the CX-r30-B hole): freeze
 *   the verifier on sight of the deleted fd, pwrite the prebuilt
 *   honest image, resume — the frozen verifier cannot spawn `ls-files`
 *   before the bytes land.
 * - path-form (`verifier-index-*`, drift-checked ino+ctimeMs at
 *   finish): write the image in place — a write landing inside the
 *   same ctime-ms bucket keeps the finish re-stat clean.
 */
const startSnapshotHijacker = (vpid: number, imgPath: string, marker: string, secs = 120) => {
  const script =
    "import os,sys,time,glob\n" +
    "vpid=int(sys.argv[1]); imgpath=sys.argv[2]; marker=sys.argv[3].encode(); end=time.time()+float(sys.argv[4]); img=None\n" +
    "while time.time()<end:\n" +
    "    hit=False\n" +
    "    for p in glob.glob('/tmp/verifier-index-%s-*'%vpid):\n" +
    "        try:\n" +
    "            body=open(p,'rb').read()\n" +
    "            if body[:4]!=b'DIRC' or marker not in body: continue\n" +
    "            if img is None: img=open(imgpath,'rb').read()\n" +
    "            f=os.open(p, os.O_WRONLY)\n" +
    "            os.write(f, img); os.ftruncate(f, len(img)); os.close(f)\n" +
    "            hit=True\n" +
    "        except: pass\n" +
    "    try: names=os.listdir('/proc/%s/fd'%vpid)\n" +
    "    except: names=[]\n" +
    "    for n in names:\n" +
    "        try:\n" +
    "            if ' (deleted)' not in os.readlink('/proc/%s/fd/%s'%(vpid,n)): continue\n" +
    "            f=os.open('/proc/%s/fd/%s'%(vpid,n), os.O_RDWR)\n" +
    "            if os.pread(f,4,0)!=b'DIRC': os.close(f); continue\n" +
    "            sz=os.fstat(f).st_size\n" +
    "            body=os.pread(f,sz,0)\n" +
    "            if marker not in body: os.close(f); continue\n" +
    "            os.kill(vpid,19)\n" +
    "            if img is None: img=open(imgpath,'rb').read()\n" +
    "            os.pwrite(f, img, 0); os.ftruncate(f, len(img))\n" +
    "            os.close(f)\n" +
    "            os.kill(vpid,18)\n" +
    "            hit=True\n" +
    "        except: pass\n" +
    "    if hit: os._exit(0)\n" +
    "    time.sleep(0.00002)\n";
  const child = spawn("python3", ["-c", script, String(vpid), imgPath, marker, String(secs)], {
    stdio: "ignore",
  });
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

/**
 * Hold-open index injection — spawn-sighted verifier freeze: `git add`
 * runs ~15-20ms end to end but its `[index-commit -> post-op indexPin]`
 * tail is ~50-200us — too tight to beat with a post-write poll. Freeze
 * EVERY unseen verifier child on first /proc sight (same-UID SIGSTOP,
 * r29 convention); the one whose argv carries `add` freezes the
 * VERIFIER, then is released so the op completes. While the verifier
 * is held a retrying `update-index` lands the foreign `x/evil.txt`
 * stage in the real index the instant `add` commits its `index.lock`
 * rename — the still-frozen verifier cannot run its post-op indexPin
 * first, so the pin and the coverage snapshot both baseline-attest the
 * entry. The snapshot scrub runs in `startSnapshotHijacker`.
 */
const startIndexInjector = (cmd: string, secs = 60) => {
  const script =
    "import os,sys,time\n" +
    "pid=int(sys.argv[1]); cmd=sys.argv[2]; end=time.time()+float(sys.argv[3]); seen=set(); retries={}; me=str(os.getpid()); done=False\n" +
    "def kids():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%pid):\n" +
    "            try: out += open('/proc/%s/task/%s/children'%(pid,t)).read().split()\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return out\n" +
    "while time.time()<end and not done:\n" +
    "    for k in kids():\n" +
    "        if k in seen or k==me: continue\n" +
    "        try: os.kill(int(k),19)\n" +
    "        except: seen.add(k); continue\n" +
    "        try: c=open('/proc/%s/cmdline'%k,'rb').read()\n" +
    "        except: c=b''\n" +
    "        av=c.split(b'\\0')\n" +
    "        a0=av[0]\n" +
    "        ambig=(a0==b'' or a0.endswith(b'/node') or a0==b'node' or a0.endswith(b'/python3'))\n" +
    "        if len(av)>1 and b'add' in av[1:]:\n" +
    "            try: os.kill(pid,19)\n" +
    "            except: pass\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "            rc=-1\n" +
    "            for _ in range(300):\n" +
    "                rc=os.system(cmd)\n" +
    "                if rc==0: break\n" +
    "                time.sleep(0.001)\n" +
    "            try: os.kill(pid,18)\n" +
    "            except: pass\n" +
    "            done=True\n" +
    "        elif (a0 and not ambig):\n" +
    "            seen.add(k)\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "        else:\n" +
    "            n=retries.get(k,0)+1; retries[k]=n\n" +
    "            if n>400: seen.add(k)\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: seen.add(k)\n" +
    "    time.sleep(0.00002)\n";
  const child = spawn("python3", ["-c", script, String(process.pid), cmd, String(secs)], {
    stdio: "ignore",
  });
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

describe("CX-r30-B: the frozen coverage snapshot is an unpinned O_TMPFILE fd", () => {
  it(
    "a /proc fd pwrite launders a foreign mid-window index stage past the staged-set diff — exit 0 with `x/evil.txt` persisted",
    { timeout: 240_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 30 && forged === 0; attempt++) {
        const root = mkRepo();
        // Spawn the injector at the very top of the attempt — the
        // python exec latency (~30-60ms) must clear before the
        // pipeline's `add` child appears ~80ms later. The foreign blob
        // sha is read from a file written moments later.
        const img = path.join(os.tmpdir(), `cx30b-img-${process.pid}-${attempt}`);
        const injector = startIndexInjector(
          `printf '100644 %s 0\\tx/evil.txt\\n' "$(cat '${root}/.foreign.sha')" | git -C '${root}' update-index --index-info`,
          60,
        );
        mkdirSync(path.join(root, "d"), { recursive: true });
        writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
        const foreign = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
          input: "FORGED\n",
          encoding: "utf8",
        }).trim();
        writeFileSync(path.join(root, ".foreign.sha"), foreign + "\n");
        // Prebuild the honest post-add image on a scratch index —
        // exactly `add -A -- d` without the foreign entry.
        copyFileSync(path.join(root, ".git", "index"), img);
        // `update-index --add` builds the identical staged set here —
        // its argv must NOT carry the `add` token or the injector would
        // match this child instead of the judged op (a pre-op injection
        // would land the marker in the claims index and the hijacker
        // would corrupt that fd itself).
        execFileSync("git", ["-C", root, "update-index", "--add", "d/normal.txt"], {
          encoding: "utf8",
          env: { ...process.env, GIT_INDEX_FILE: img },
        });
        // Spawn the injectors BEFORE the preflight await — the python
        // startup latency (~30-60ms) would otherwise race the pipeline's
        // early window and the `add` child would spawn unseen.
        const hijack = startSnapshotHijacker(process.pid, img, "x/evil.txt");
        try {
          const pre = await evidenceRepoPreflight(root);
          expect(pre).not.toBeNull();
          const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], {
            preflight: pre!,
          });
          if (r.exitCode === -1) refused++;
          else {
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
          injector.stop();
          hijack.stop();
        }
      }
      console.log(`snapshot-fd-hijack: forged=${forged} refused=${refused} honest=${honest}`);
      expect(forged).toBe(0);
    },
  );

  it("control: quiet window — exit 0 and no foreign entry", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(0);
    const staged = git(root, ["ls-files", "-s"]);
    expect(staged).toContain("d/normal.txt");
    expect(staged).not.toContain("evil");
  });
});
