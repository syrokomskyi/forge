/*
RFC-1616 round-37 regression — the silent-write channel class is closed.

Background: the r36 acceptance battery flipped loose objects, commit
objects, metadir files, refs, and `.git/index` mid-consult through
read-first `mmap(MAP_SHARED)` stores — silent to every `{ino,ctime,size}`
pin and to inotify alike on tmpfs — and forged judged evidence on every
channel (docs/reviews/acceptance/rfc-1616/r36-verify/, forged=10/10 per
class).

R37 closes the CLASS rather than the instances:

  A    write barrier — the owner write bit is stripped at capture on
       every live-consulted file (object store, index, sharedindex.*),
       and a procfs audit refuses any file that carried a writable
       description or MAP_SHARED mapping installed while it was still
       writable (chmod cannot revoke a held description).
  B    sibling-metadir consultable members ({HEAD, gitdir, commondir,
       locked}) are judged and minted into the gitdir overlay;
       pure-flag `rev-parse` geometry answers in-process from the
       fingerprint so no live geometry consult exists to forge.
  C    covered by A — commit/tree objects are loose objects.
  D    `extraWatchPaths` worktree files take an arm-time barrier +
       audit, restored at settle.
  E    claims enumeration reads the CAPTURED index image from a held
       copy (GIT_INDEX_FILE=<held>) — the capture→enumeration window
       no longer exists.
  belt `cat-file <type> <oid>` re-hashes served bytes to the name.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { unprovenIgnoredPaths, verifierGit } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx37-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/** Loose-object path for a given sha inside a repo. */
const objPath = (root: string, sha: string) =>
  path.join(root, ".git", "objects", sha.slice(0, 2), sha.slice(2));

/** Deterministic pseudo-random text — incompressible enough that a
 * compressed blob's size tracks its body length linearly. */
const prand = (n: number, seed: number): Buffer =>
  Buffer.from(
    Array.from({ length: n }, (_, i) =>
      String.fromCharCode(33 + ((i * 7919 + seed * 37 + i * i * 11) % 94)),
    ).join(""),
  );

/** A zlib stream that inflates to a valid `blob` object of `size` bytes compressed. */
const forgedStream = (size: number): Buffer | null => {
  for (let pad = 0; pad < 200000; pad++) {
    const n = pad + 32;
    const body = Buffer.concat([
      Buffer.from(`blob ${n}\0`),
      Buffer.from(`FORGED-PAYLOAD-${pad}-`),
      prand(Math.max(0, n - `FORGED-PAYLOAD-${pad}-`.length), pad + 1),
    ]);
    const c = zlib.deflateSync(body, { level: 6 });
    if (c.length === size) return c;
    if (c.length > size + 8) return null; // monotonic-ish — stop walking away
  }
  return null;
};

describe("CX-r37-A: write barrier + procfs audit bound the live object store", () => {
  it("a persistent silent mmap flip of a loose object never serves forged bytes", async () => {
    const root = mkRepo();
    // A payload incompressible enough that a forged zlib stream can
    // size-match the honest object's compressed length (the mmap flip
    // keeps {ino,ctime,size} — same byte length is the primitive).
    writeFileSync(path.join(root, "big.txt"), Buffer.concat([prand(240, 7), Buffer.from("\n")]));
    git(root, ["add", "big.txt"]);
    git(root, ["commit", "-qm", "c2"]);
    const sha = git(root, ["rev-parse", "HEAD:big.txt"]);
    const bp = objPath(root, sha);
    chmodSync(bp, 0o644);
    const honest = readFileSync(bp);
    const forged = forgedStream(honest.length);
    expect(forged).not.toBeNull();
    // Arm a writable shared mapping and flip — the read-first store
    // bumps no ctime and fires no event (r36's silent primitive).
    const forgedPath = path.join(root, "forged.bin");
    writeFileSync(forgedPath, forged!);
    const py = spawnSync("python3", [
      "-c",
      "import os,sys,mmap\n" +
        "fd=os.open(sys.argv[1],os.O_RDWR);m=mmap.mmap(fd,os.fstat(fd).st_size,mmap.MAP_SHARED,mmap.PROT_READ|mmap.PROT_WRITE)\n" +
        "_=m[0];m[:]=open(sys.argv[2],'rb').read()\n",
      bp,
      forgedPath,
    ]);
    expect(py.status ?? 1, String(py.stderr)).toBe(0);
    // The flipped bytes sit on the store; the consult must refuse —
    // the belt re-hash catches even a memo-skipped scan.
    const r = await verifierGit(root, ["cat-file", "blob", sha]);
    expect(r.exitCode, `stderr=${r.stderr.slice(0, 200)}`).toBe(-1);
  });

  it("a writable description held open on an object refuses the consult outright", async () => {
    const root = mkRepo();
    const sha = git(root, ["rev-parse", "HEAD:f.txt"]);
    const bp = objPath(root, sha);
    chmodSync(bp, 0o644);
    // The adversary's prepared channel: an O_RDWR description opened
    // while the file was still writable — chmod cannot revoke it, so
    // the procfs audit is the only proof there is none.
    const held = openSync(bp, "r+");
    try {
      const r = await verifierGit(root, ["cat-file", "blob", sha]);
      expect(r.exitCode, `stderr=${r.stderr.slice(0, 200)}`).toBe(-1);
    } finally {
      closeSync(held);
    }
    // Channel released — the barrier alone now bounds the store; the
    // same consult serves the object's real bytes honestly.
    const ok = await verifierGit(root, ["cat-file", "blob", sha]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("v1");
  });

  it("the write barrier leaves git's own index writes working (lock+rename)", async () => {
    const root = mkRepo();
    const r = await verifierGit(root, ["rev-parse", "HEAD"]);
    expect(r.exitCode).toBe(0);
    const indexPath = path.join(root, ".git", "index");
    expect(statSync(indexPath).mode & 0o222).toBe(0);
    // Real index writes go through .git/index.lock + rename — the
    // read-only old inode is no obstacle.
    writeFileSync(path.join(root, "g.txt"), "v2\n");
    git(root, ["add", "g.txt"]);
    git(root, ["commit", "-qm", "c2"]);
    const r2 = await verifierGit(root, ["status", "--porcelain"]);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.trim()).toBe("");
  });
});

describe("CX-r37-B: geometry consults answer judged state, never live gitdir bytes", () => {
  it("pure-flag rev-parse answers in-process from the fingerprint", async () => {
    const root = mkRepo();
    const own = `${root}-wt`;
    git(root, ["worktree", "add", "-q", own]);
    tmpdirs.push(own);
    // The judged channel pins GIT_DIR absolutely, so `--git-dir` &
    // friends print ABSOLUTE answers — compare against the same
    // env-pinned git, never the unenv'd relative form.
    const envGit = (args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: path.join(root, ".git"),
          GIT_WORK_TREE: root,
        },
      }).trim();
    for (const flag of ["--git-dir", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"]) {
      const r = await verifierGit(root, ["rev-parse", flag]);
      expect(r.exitCode, flag).toBe(0);
      expect(r.stdout.trim(), flag).toBe(envGit(["rev-parse", flag]));
    }
    const inside = await verifierGit(root, ["rev-parse", "--is-inside-git-dir"]);
    expect(inside.stdout.trim()).toBe("false");
    const insideGit = await verifierGit(path.join(root, ".git"), [
      "rev-parse",
      "--is-inside-git-dir",
    ]);
    expect(insideGit.stdout.trim()).toBe("true");
  });

  it("worktree list serves minted sibling-metadir state — a malformed sibling refuses", async () => {
    const root = mkRepo();
    const sib = `${root}-sib`;
    git(root, ["worktree", "add", "-q", sib, "-b", "side"]);
    tmpdirs.push(sib);
    const honest = await verifierGit(root, ["worktree", "list", "--porcelain"]);
    expect(honest.exitCode).toBe(0);
    // The main entry must be the real WORKTREE path — the overlay
    // mint path must never survive substitution (a `worktree
    // <root>/.git` answer made `primaryWorktree` resolve the gitdir
    // as the primary checkout — status there answered ` D` for every
    // claim, FLOW-CUT-07).
    expect(honest.stdout.split("\n")[0]).toBe(`worktree ${root}`);
    expect(honest.stdout).toContain(`worktree ${sib}\n`);
    expect(honest.stdout).not.toContain("/.git");
    expect(honest.stdout).not.toContain("forge-evidence-");
    expect(honest.stdout).toContain("branch refs/heads/side");
    // The same consult from the linked worktree: the main entry is the
    // PRIMARY worktree (commondir-minus-/.git), not its gitdir either.
    const fromSib = await verifierGit(sib, ["worktree", "list", "--porcelain"]);
    expect(fromSib.exitCode).toBe(0);
    expect(fromSib.stdout.split("\n")[0]).toBe(`worktree ${root}`);
    expect(fromSib.stdout).toContain(`worktree ${sib}\n`);
    expect(fromSib.stdout).not.toContain("forge-evidence-");
    // A sibling metadir HEAD is a consultable member now — corrupt it
    // and the judge's well-formedness check refuses the consult.
    const sibHead = path.join(root, ".git", "worktrees", path.basename(sib), "HEAD");
    writeFileSync(sibHead, "not-a-ref\n");
    const forged = await verifierGit(root, ["worktree", "list", "--porcelain"]);
    expect(forged.exitCode).toBe(-1);
  });

  it("a mid-window sibling-metadir flip serves minted bytes or refuses — never live-forged", async () => {
    if (!HAS_PY) return;
    const root = mkRepo();
    const sib = `${root}-sib`;
    git(root, ["worktree", "add", "-q", sib, "-b", "side"]);
    tmpdirs.push(sib);
    const sibHead = path.join(root, ".git", "worktrees", path.basename(sib), "HEAD");
    const honestBytes = readFileSync(sibHead);
    const forgedBytes = Buffer.from("ref: refs/heads/forged-branch\n");
    const orig = path.join(root, "orig.bin");
    const forg = path.join(root, "forg.bin");
    writeFileSync(orig, honestBytes);
    writeFileSync(forg, forgedBytes);
    // The hijacker: mmap-flip the sibling HEAD for any `worktree`
    // child's lifetime, restore after — invisible to stat+inotify.
    const script =
      "import os,sys,mmap,time\n" +
      "target,forg_path,orig_path,vpid=sys.argv[1:5]\n" +
      "forged=open(forg_path,'rb').read();orig=open(orig_path,'rb').read()\n" +
      "def kids():\n" +
      "    out=[]\n" +
      "    try:\n" +
      "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
      "            try: out+=open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
      "            except: pass\n" +
      "    except: pass\n" +
      "    return out\n" +
      "def argv(k):\n" +
      "    try: return open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
      "    except: return []\n" +
      "end=time.time()+30\n" +
      "while time.time()<end:\n" +
      "    for k in kids():\n" +
      "        av=argv(k)\n" +
      "        if b'worktree' in av:\n" +
      "            try:\n" +
      "                fd=os.open(target,os.O_RDWR)\n" +
      "                m=mmap.mmap(fd,os.fstat(fd).st_size,mmap.MAP_SHARED,mmap.PROT_READ|mmap.PROT_WRITE)\n" +
      "                m[:]=forged.ljust(len(orig),b'\\n')\n" +
      "            except: pass\n" +
      "    time.sleep(0.00005)\n";
    const hijacker = spawnSyncIgnored(script, [sibHead, forg, orig, String(process.pid)]);
    try {
      const r = await verifierGit(root, ["worktree", "list", "--porcelain"]);
      // Forged-branch must never be the consulted answer: refuse
      // (-1) or the capture-time honest side branch.
      expect(r.exitCode === -1 || r.stdout.includes("branch refs/heads/side")).toBe(true);
      expect(r.stdout.includes("forged-branch")).toBe(false);
    } finally {
      hijacker?.kill("SIGKILL");
    }
  });
});

describe("CX-r37-C/D: held-channel + arm-time barrier on worktree sources", () => {
  it("a writable description on HEAD's commit object refuses status", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "dirty\n");
    const commitSha = git(root, ["rev-parse", "HEAD"]);
    const cp = objPath(root, commitSha);
    chmodSync(cp, 0o644);
    const held = openSync(cp, "r+");
    try {
      const r = await verifierGit(root, ["status", "--porcelain"]);
      expect(r.exitCode, `stderr=${r.stderr.slice(0, 200)}`).toBe(-1);
    } finally {
      closeSync(held);
    }
    const ok = await verifierGit(root, ["status", "--porcelain"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("f.txt");
  });

  it("unprovenIgnoredPaths: an armed worktree rule source refuses — never `!!`-forged", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "x"), { recursive: true });
    writeFileSync(path.join(root, "x", ".gitignore"), "visible\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "c2"]);
    writeFileSync(path.join(root, "x", ".gitignore"), "hidden\n");
    writeFileSync(path.join(root, "x", "hidden"), "secret\n");
    // Baseline: the dirty rule source leaves x/hidden unproven.
    const base = await unprovenIgnoredPaths(root, ["x/hidden"]);
    expect(base !== null && base.has("x/hidden")).toBe(true);
    // Arm the rule source — the consult's extraWatchPaths audit must
    // find the held channel before any check-ignore/diff answer.
    const held = openSync(path.join(root, "x", ".gitignore"), "r+");
    try {
      const r = await unprovenIgnoredPaths(root, ["x/hidden"]);
      expect(r === null || r.has("x/hidden")).toBe(true);
    } finally {
      closeSync(held);
    }
  });
});

describe("CX-r37-E: claims enumeration reads the captured index image", () => {
  it("a mid-preflight live-index flip can no longer shape the claims set", async () => {
    if (!HAS_PY) return;
    const root = mkRepo();
    const indexPath = path.join(root, ".git", "index");
    // C1 = index without the staged file, padded to C0's byte length
    // so an mmap flip preserves size+ctime.
    const c1Raw = path.join(root, "c1.idx");
    const c0 = path.join(root, "c0.idx");
    const c1 = path.join(root, "c1p.idx");
    writeFileSync(path.join(root, "c1.idx"), readFileSync(indexPath));
    writeFileSync(path.join(root, "secret.sh"), "evil\n");
    git(root, ["add", "secret.sh"]);
    writeFileSync(c0, readFileSync(indexPath));
    const pad = spawnSync("python3", [
      "-c",
      "import struct,hashlib,sys\n" +
        "c1=open(sys.argv[1],'rb').read();c0=open(sys.argv[2],'rb').read()\n" +
        "body=c1[:-20];padlen=len(c0)-len(c1)-8\n" +
        "assert padlen>=0\n" +
        "new=body+b'ZZZZ'+struct.pack('>I',padlen)+b'P'*padlen\n" +
        "new+=hashlib.sha1(new).digest()\n" +
        "assert len(new)==len(c0)\n" +
        "open(sys.argv[3],'wb').write(new)\n",
      c1Raw,
      c0,
      c1,
    ]);
    expect(pad.status).toBe(0);
    // Flip the LIVE index to C1 for any ls-files child's lifetime —
    // under R36 this minted claims carrying a staged set that never
    // existed at capture; the held copy makes the flip irrelevant.
    const script =
      "import os,sys,mmap,time\n" +
      "idx,c1_path,c0_path,vpid=sys.argv[1:5]\n" +
      "c1=open(c1_path,'rb').read();c0=open(c0_path,'rb').read()\n" +
      "def kids():\n" +
      "    out=[]\n" +
      "    try:\n" +
      "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
      "            try: out+=open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
      "            except: pass\n" +
      "    except: pass\n" +
      "    return out\n" +
      "def argv(k):\n" +
      "    try: return open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
      "    except: return []\n" +
      "end=time.time()+30\n" +
      "while time.time()<end:\n" +
      "    for k in kids():\n" +
      "        av=argv(k)\n" +
      "        if b'ls-files' in av:\n" +
      "            try:\n" +
      "                fd=os.open(idx,os.O_RDWR)\n" +
      "                m=mmap.mmap(fd,os.fstat(fd).st_size,mmap.MAP_SHARED,mmap.PROT_READ|mmap.PROT_WRITE)\n" +
      "                m[:]=c1\n" +
      "            except: pass\n" +
      "    time.sleep(0.00005)\n";
    const hijacker = spawnSyncIgnored(script, [indexPath, c1, c0, String(process.pid)]);
    try {
      const r = await verifierGit(root, ["status", "--porcelain", "--untracked-files=no"]);
      // A staged secret.sh must never read clean — refuse or honest.
      const clean = r.exitCode === 0 && r.stdout.trim() === "";
      expect(clean, `forged-clean: ${JSON.stringify(r)}`).toBe(false);
    } finally {
      hijacker?.kill("SIGKILL");
    }
  });
});

describe("CX-r37-F/G: honest consults stay honest through the new bounds", () => {
  it("ordinary reads answer truthfully — rev-parse, status, cat-file, log, merge-base", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "v2\n");
    git(root, ["add", "f.txt"]);
    git(root, ["commit", "-qm", "c2"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const r1 = await verifierGit(root, ["rev-parse", "HEAD"]);
    expect(r1.exitCode === 0 && r1.stdout.trim() === head).toBe(true);
    const sha = git(root, ["rev-parse", "HEAD:f.txt"]);
    const r2 = await verifierGit(root, ["cat-file", "blob", sha]);
    expect(r2.exitCode === 0 && r2.stdout === "v2\n").toBe(true);
    const r3 = await verifierGit(root, ["status", "--porcelain"]);
    expect(r3.exitCode === 0 && r3.stdout.trim() === "").toBe(true);
    const r4 = await verifierGit(root, ["log", "-1", "--format=%s"]);
    expect(r4.exitCode === 0 && r4.stdout.trim() === "c2").toBe(true);
    git(root, ["branch", "-f", "side", "HEAD~1"]);
    const mb = await verifierGit(root, ["merge-base", "HEAD", "side"]);
    expect(mb.exitCode === 0 && mb.stdout.trim() === git(root, ["rev-parse", "HEAD~1"])).toBe(true);
  });
});

/** Spawn a python hijacker detached — the caller kills it in `finally`. */
function spawnSyncIgnored(script: string, argv: string[]) {
  const child = spawn("python3", ["-c", script, ...argv], { stdio: "ignore" });
  child.unref();
  return child;
}
