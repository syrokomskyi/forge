/*
RFC-1616 round-32 independent adversarial probes — candidate commit
e32510593, exported tree.

CX-r32-B — the frozen LIVE-index snapshot in
`verifyAnchoredMutationCoverage` (verifier-git.ts:4555-4588) is an
O_TMPFILE fd that is neither watched nor per-spawn re-proved:

  - `evidenceWindowFiles` (:3545-3558) arms `fsWatch` only on
    `preflight.index` (the CLAIMS fd) — the post-op live snapshot minted
    later inside the coverage proof is invisible to inotify.
  - `runLive` (:4596-4620) reopens `/dev/fd/N` per child with NO byte
    re-proof (unlike `evidenceSpawnState`'s spawn-time compare at :919).
  - The only integrity check is `finish()`'s readback at :4674-4686 —
    bytes must equal `liveIndex.bytes` WHEN coverage ends.

A same-UID pwrite through `/proc/<vpid>/fd/N` therefore feeds forged
index bytes to every live-snapshot child (`ls-files -s`, scoped
`ls-files`, `diff --cached`), and a restore of the ORIGINAL bytes before
`finish()`'s readback erases the evidence: the byte+size pin attests the
attacker-restored state. Flip→restore escapes both layers.

Attack shape (CX-r30-B's staged-set forgery re-opened on the fd side):

  1. Freeze the anchored `reset -q -- d` child on /proc sight; inject
     foreign stage `x/evil.txt` into the REAL `.git/index`
     (`update-index --index-info`); resume — the post-op index and its
     indexPin baseline both carry the foreign entry (index events are
     the op's own surface, ignored by the armed watch).
  2. The verifier copies those bytes into the O_TMPFILE liveIndex.
     Hijacker spots the deleted-fd DIRC image containing `x/evil.txt`,
     snapshots it, and pwrites the prebuilt honest image ({f.txt}) —
     every live child now enumerates a staged set WITHOUT the foreign
     entry: liveMap ≡ forged, claimsMap carries {f.txt,d/normal.txt},
     `changed` = {d/normal.txt} ⊆ extent, `diff --cached` clean →
     coverage passes.
  3. On the last coverage child (`diff --cached`) exit the hijacker
     freezes the verifier, restores the original snapshot bytes,
     resumes — `finish()`'s readback sees `liveIndex.bytes` again.
  4. `reset` exits 0 attesting a clean staged set while the REAL index
     keeps `x/evil.txt` — ships in the caller's next commit.

Honest outcomes: refused = exitCode -1 (EVIDENCE-REFUSED); honest =
non-zero/other exit or foreign stage absent; forged = exit 0 with
`x/evil.txt` still staged at the attacker blob.

Fix: `runLive` fd-form now re-proves the snapshot per spawn — the same
size+bytes readback `evidenceSpawnState` performs for the claims fd.
A `/proc/<pid>/fd` pwrite makes the NEXT coverage child open a
re-proved description whose bytes no longer match `liveIndex.bytes`,
so the consult refuses at the spawn boundary instead of feeding forged
index content; the restore-before-`finish()` trick is moot because the
refusal already fired. Note `O_TMPFILE` is never defined under stock
Node (`DefineFsConstants` exports no such constant) — the probe sets
it to exercise the branch other runtimes may activate.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evidenceAnchoredGit, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";
import { constants as fsConstants } from "node:fs";

// This Node build omits `O_TMPFILE` from `fs.constants` even though
// the kernel/filesystem support it (python `os.O_TMPFILE` opens fine).
// The implementation PREFERS the O_TMPFILE fd-form liveIndex whenever
// the constant exists (:4567-4575) — standard Linux Node builds do
// expose it — so patch the constant in to exercise the production
// fd-form this probe targets. The named-path fallback is pinned by
// ino+ctime+bytes and was already refused in the path-form variant.
(fsConstants as { O_TMPFILE?: number }).O_TMPFILE = 0o20200000;

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx32b-"));
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
 * Hold-open index injection (r30/r31 convention): freeze the verifier's
 * `reset` child on first /proc sight, freeze the verifier itself, land
 * the foreign stage via `update-index --index-info`, release both.
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
    "        if len(av)>1 and (b'reset' in av[1:]):\n" +
    "            try: os.kill(pid,19)\n" +
    "            except: pass\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "            rc=-1\n" +
    "            for _ in range(400):\n" +
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

/**
 * Snapshot flip→restore: watch /proc/<vpid>/fd for the deleted-fd DIRC
 * liveIndex image containing `marker`, save its bytes, freeze the
 * verifier and pwrite the forged image (`imgPath`), resume. Then watch
 * for the LAST live-snapshot child (`diff` argv — `diff --cached` is the
 * final coverage read for `reset`): on its exit freeze the verifier
 * again, restore the ORIGINAL bytes so `finish()`'s readback attests the
 * untouched snapshot, resume.
 */
const startSnapshotFlipRestore = (
  vpid: number,
  imgPath: string,
  marker: string,
  secs = 120,
  logPath?: string,
) => {
  const script =
    "import os,sys,time\n" +
    "vpid=int(sys.argv[1]); imgpath=sys.argv[2]; marker=sys.argv[3].encode(); end=time.time()+float(sys.argv[4]); log=open(sys.argv[5],'a')\n" +
    "img=None; orig=None; tgtfd=None; patched=False; restored=False; diffSeen=False; me=str(os.getpid()); t0=time.time()\n" +
    "def lg(m):\n" +
    "    log.write('%.1f %s\\n'%((time.time()-t0)*1000,m)); log.flush()\n" +
    "def kids():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
    "            try: out += open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return out\n" +
    "def hasdiff(ks):\n" +
    "    for k in ks:\n" +
    "        if k==me: continue\n" +
    "        try: av=open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
    "        except: av=[]\n" +
    "        if b'diff' in av: return True\n" +
    "    return False\n" +
    "while time.time()<end and not restored:\n" +
    "    if not patched:\n" +
    "        try: names=os.listdir('/proc/%s/fd'%vpid)\n" +
    "        except: names=[]\n" +
    "        for n in names:\n" +
    "            try:\n" +
    "                if ' (deleted)' not in os.readlink('/proc/%s/fd/%s'%(vpid,n)): continue\n" +
    "                f=os.open('/proc/%s/fd/%s'%(vpid,n), os.O_RDWR)\n" +
    "            except: continue\n" +
    "            try:\n" +
    "                if os.pread(f,4,0)!=b'DIRC': os.close(f); continue\n" +
    "                sz=os.fstat(f).st_size\n" +
    "                body=os.pread(f,sz,0)\n" +
    "                if marker not in body: os.close(f); continue\n" +
    "                os.kill(vpid,19)\n" +
    "                if img is None: img=open(imgpath,'rb').read()\n" +
    "                orig=body\n" +
    "                os.pwrite(f, img, 0); os.ftruncate(f, len(img)); os.close(f)\n" +
    "                os.kill(vpid,18)\n" +
    "                tgtfd=n; patched=True; lg('patched fd=%s sz=%d'%(n,sz))\n" +
    "            except Exception as e: lg('patcherr %s'%e)\n" +
    "        time.sleep(0.00002)\n" +
    "    else:\n" +
    "        ks=kids(); d=hasdiff(ks)\n" +
    "        if d and not diffSeen:\n" +
    "            diffSeen=True; lg('diffseen')\n" +
    "            # Freeze the verifier so finish()'s readback cannot run,\n" +
    "            # let the diff child consume the FORGED index and exit\n" +
    "            # on its own, then restore the ORIGINAL bytes before\n" +
    "            # resuming — finish() attests the restored state.\n" +
    "            try: os.kill(vpid,19)\n" +
    "            except: pass\n" +
    "            wt=time.time()+0.5\n" +
    "            while time.time()<wt and hasdiff(kids()): time.sleep(0.0002)\n" +
    "            lg('diffgone')\n" +
    "            try:\n" +
    "                f=os.open('/proc/%s/fd/%s'%(vpid,tgtfd), os.O_RDWR)\n" +
    "                os.pwrite(f, orig, 0); os.ftruncate(f, len(orig)); os.close(f)\n" +
    "                restored=True; lg('restored')\n" +
    "            except Exception as e: lg('restoreerr %s'%e)\n" +
    "            try: os.kill(vpid,18)\n" +
    "            except: pass\n" +
    "        time.sleep(0.00002)\n" +
    "lg('exit patched=%s restored=%s'%(patched,restored))\n";
  const child = spawn(
    "python3",
    ["-c", script, String(vpid), imgPath, marker, String(secs), logPath ?? "/tmp/cx32b-trace.txt"],
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

describe("CX-r32-B: liveIndex O_TMPFILE flip→restore launders a foreign stage past staged-set coverage", () => {
  it(
    "forged snapshot + restore before finish() — anchored reset exits 0 with x/evil.txt staged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkRepo();
        const img = path.join(os.tmpdir(), `cx32b-img-${process.pid}-${attempt}`);
        const injector = startIndexInjector(
          `printf '100644 %s 0\\tx/evil.txt\\n' "$(cat '${root}/.foreign.sha')" | git -C '${root}' update-index --index-info`,
          60,
        );
        try {
          mkdirSync(path.join(root, "d"), { recursive: true });
          writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
          const foreign = git(root, ["hash-object", "-w", "--stdin"], "FORGED\n");
          writeFileSync(path.join(root, ".foreign.sha"), foreign + "\n");
          // The honest post-reset snapshot — `reset -q -- d` restores
          // the `d` extent to HEAD's tree, i.e. index = {f.txt}. That
          // is exactly the pre-`add` index, so snapshot it BEFORE
          // staging d/normal.txt. (`update-index --remove` keeps
          // entries whose worktree file exists — a stale d/normal.txt
          // in the forged image would honestly diverge.)
          copyFileSync(path.join(root, ".git", "index"), img);
          git(root, ["add", "d/normal.txt"]);
          const hijack = startSnapshotFlipRestore(process.pid, img, "x/evil.txt");
          try {
            const pre = await evidenceRepoPreflight(root);
            expect(pre).not.toBeNull();
            const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "d"], {
              preflight: pre!,
            });
            if (r.exitCode === -1) {
              refused++;
              lastErr = r.stderr.slice(0, 140);
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
        } finally {
          injector.stop();
        }
      }
      console.log(
        `liveIndex flip→restore (reset): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );

  it(
    "path-form fallback: pwrite+restore on `verifier-index-*` — ctime pin refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      // Force the named-path liveIndex form (stock-Node path) for
      // this call only — the constant is read at mint time.
      const saved = (fsConstants as { O_TMPFILE?: number }).O_TMPFILE;
      delete (fsConstants as { O_TMPFILE?: number }).O_TMPFILE;
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      try {
        for (let attempt = 0; attempt < 30; attempt++) {
          const root = mkRepo();
          const img = path.join(os.tmpdir(), `cx32b-pimg-${process.pid}-${attempt}`);
          mkdirSync(path.join(root, "d"), { recursive: true });
          writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
          const foreign = git(root, ["hash-object", "-w", "--stdin"], "FORGED\n");
          writeFileSync(path.join(root, ".foreign.sha"), foreign + "\n");
          copyFileSync(path.join(root, ".git", "index"), img);
          git(root, ["add", "d/normal.txt"]);
          // ONE python process owns every SIGSTOP/SIGCONT — two
          // helpers' freezes interleave otherwise (a stray SIGCONT
          // releases the injector's freeze early and the retrying
          // update-index lands mid-coverage as indexPin drift).
          const script =
            "import os,sys,time\n" +
            "vpid=int(sys.argv[1]); cmd=sys.argv[2]; imgp=sys.argv[3]; marker=sys.argv[4].encode(); end=time.time()+float(sys.argv[5]); log=open('/tmp/cx32b-ptrace.txt','a')\n" +
            "me=str(os.getpid()); seen=set(); retries={}; injected=False; patched=False; restored=False; diffSeen=False\n" +
            "img=None; orig=None; tgt=None; t0=time.time()\n" +
            "def lg(m): log.write('%.1f %s\\n'%((time.time()-t0)*1000,m)); log.flush()\n" +
            "def kids():\n" +
            "    out=[]\n" +
            "    try:\n" +
            "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
            "            try: out += open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
            "            except: pass\n" +
            "    except: pass\n" +
            "    return out\n" +
            "def hasdiff(ks):\n" +
            "    for k in ks:\n" +
            "        if k==me: continue\n" +
            "        try: av=open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
            "        except: av=[]\n" +
            "        if b'diff' in av: return True\n" +
            "    return False\n" +
            "while time.time()<end and not restored:\n" +
            "    ks=kids()\n" +
            "    if not injected:\n" +
            "        for k in ks:\n" +
            "            if k in seen or k==me: continue\n" +
            "            try: os.kill(int(k),19)\n" +
            "            except: seen.add(k); continue\n" +
            "            try: c=open('/proc/%s/cmdline'%k,'rb').read()\n" +
            "            except: c=b''\n" +
            "            av=c.split(b'\\0'); a0=av[0]\n" +
            "            ambig=(a0==b'' or a0.endswith(b'/node') or a0==b'node' or a0.endswith(b'/python3'))\n" +
            "            if len(av)>1 and (b'reset' in av[1:]):\n" +
            "                try: os.kill(vpid,19)\n" +
            "                except: pass\n" +
            "                try: os.kill(int(k),18)\n" +
            "                except: pass\n" +
            "                rc=-1\n" +
            "                for _ in range(400):\n" +
            "                    rc=os.system(cmd)\n" +
            "                    if rc==0: break\n" +
            "                    time.sleep(0.001)\n" +
            "                try: os.kill(vpid,18)\n" +
            "                except: pass\n" +
            "                injected=True; lg('injected rc=%s'%rc)\n" +
            "            elif (a0 and not ambig):\n" +
            "                seen.add(k)\n" +
            "                try: os.kill(int(k),18)\n" +
            "                except: pass\n" +
            "            else:\n" +
            "                n=retries.get(k,0)+1; retries[k]=n\n" +
            "                if n>400: seen.add(k)\n" +
            "                try: os.kill(int(k),18)\n" +
            "                except: seen.add(k)\n" +
            "    elif not patched:\n" +
            "        # The `verifier-index-*` file lives ~20-40ms — tmpdir\n" +
            "        # listdir is too slow to catch it reliably. Instead\n" +
            "        # freeze the verifier on the FIRST post-injection git\n" +
            "        # child (coverage children spawn only after the file\n" +
            "        # is minted), then patch while it is stopped — the\n" +
            "        # child has not consumed the index yet at spawn+0ms.\n" +
            "        for k in ks:\n" +
            "            if k==me: continue\n" +
            "            try: a0=open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')[0]\n" +
            "            except: a0=b''\n" +
            "            if not (a0.endswith(b'/git') or a0==b'git'): continue\n" +
            "            try: os.kill(vpid,19)\n" +
            "            except: pass\n" +
            "            try:\n" +
            "                names=[n for n in os.listdir(os.path.dirname(imgp)) if n.startswith('verifier-index-')]\n" +
            "                for n in names:\n" +
            "                    p=os.path.join(os.path.dirname(imgp),n)\n" +
            "                    try:\n" +
            "                        body=open(p,'rb').read()\n" +
            "                        if body[:4]!=b'DIRC' or marker not in body: continue\n" +
            "                        if img is None: img=open(imgp,'rb').read()\n" +
            "                        orig=body\n" +
            "                        open(p,'wb').write(img)\n" +
            "                        tgt=p; patched=True; lg('patched %s'%n)\n" +
            "                    except Exception as e: lg('patcherr %s'%e)\n" +
            "            finally:\n" +
            "                try: os.kill(vpid,18)\n" +
            "                except: pass\n" +
            "            break\n" +
            "    else:\n" +
            "        d=hasdiff(ks)\n" +
            "        if d and not diffSeen:\n" +
            "            diffSeen=True; lg('diffseen')\n" +
            "            try: os.kill(vpid,19)\n" +
            "            except: pass\n" +
            "            wt=time.time()+0.5\n" +
            "            while time.time()<wt and hasdiff(kids()): time.sleep(0.0002)\n" +
            "            try: open(tgt,'wb').write(orig); restored=True; lg('restored')\n" +
            "            except Exception as e: lg('restoreerr %s'%e)\n" +
            "            try: os.kill(vpid,18)\n" +
            "            except: pass\n" +
            "    time.sleep(0.00002)\n";
          const hijack = spawn(
            "python3",
            [
              "-c",
              script,
              String(process.pid),
              `printf '100644 %s 0\\tx/evil.txt\\n' "$(cat '${root}/.foreign.sha')" | git -C '${root}' update-index --index-info`,
              img,
              "x/evil.txt",
              "120",
            ],
            { stdio: "ignore" },
          );
          hijack.unref();
          try {
            const pre = await evidenceRepoPreflight(root);
            expect(pre).not.toBeNull();
            const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "d"], {
              preflight: pre!,
            });
            if (r.exitCode === -1) {
              refused++;
              lastErr = r.stderr.slice(0, 140);
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
            hijack.kill("SIGKILL");
          }
        }
      } finally {
        (fsConstants as { O_TMPFILE?: number }).O_TMPFILE = saved;
      }
      console.log(
        `liveIndex path-form flip→restore (reset): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );

  it("control: quiet window — reset exits 0, d unstaged, no foreign entry", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    git(root, ["add", "d/normal.txt"]);
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(0);
    const staged = git(root, ["ls-files", "-s"]);
    expect(staged).not.toContain("d/normal.txt");
    expect(staged).not.toContain("evil");
  });
});
