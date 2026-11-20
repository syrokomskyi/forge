/*
RFC-1616 round-31 independent adversarial probes — candidate commit
8f18df089, exported tree.

CX-r31-C — the claims-fd append primitive (cx31b) applied to the READ
channel's per-call claims fds. `unprovenIgnoredPaths` mints a fresh
preflight (and hence a fresh held claims fd) inside EVERY `verifierGit`
spawn — the fd appears in `/proc/<pid>/fd/` with its size at the honest
length, and every later re-proof reads only that prefix. A same-UID
watcher polls `/proc/self/fd` for a newborn `DIRC`-magic fd and appends
the precomputed `link` tail through a procfs re-open — each claims child
then merges `.git/sharedindex.<sha>`.

Forge direction: a `.gitignore` that exists ONLY in the worktree
(untracked — a session-authored rule, never attested) is pushed into the
claims view by the forged base, with its staged sha equal to the worktree
bytes' blob sha — `ls-files` claims it tracked, `diff` claims it clean →
`provenSource` accepts → the `!!` member never rejoins `statusDirty`'s
verdict. No ` M`/staged tell survives: the `.gitignore` shows only as
`??` (worktree reality) while `sub/payload` is silently hidden.

Note the `add` pre-arm enumerate-freshen does NOT apply here: read spawns
run inside `armEvidenceWindowWatch` BEFORE the first claims child — the
freshen on `.git/sharedindex.<sha>` is a watched rootfile event → READS
refuse on it. To stay silent the claims-fd attack therefore points its
base at `.git` paths the fingerprint does NOT pin — impossible for
`sharedindex.<sha>` (fixed name under the root). So for the read channel
the forge needs the base lookup to succeed WITHOUT a freshen bump: the
sharedindex file must be consumed+refreshed identically at capture and
verdict... empirically the read side DOES catch the freshen as a window
event — expected outcome is refuse, not forge; the probe asserts
forged=0 (a refuse-only outcome closes the read channel for this
primitive; a forge means the freshen landed unjudged).
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unprovenIgnoredPaths } from "../../../src/utils/verifier-git.ts";
import { statusDirty } from "../../flow/git.ts";
import { ambientIo } from "../../../src/utils/io.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const claimsImageOf = (stageListing: string): Buffer => {
  const entries: { mode: number; sha: Buffer; stage: number; name: Buffer }[] = [];
  for (const rec of stageListing.split("\0")) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf("\t");
    const m = /^([0-7]+) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(rec.slice(0, tab));
    if (m === null || tab === -1) throw new Error(`bad claim ${rec}`);
    entries.push({
      mode: parseInt(m[1]!, 8),
      sha: Buffer.from(m[2]!, "hex"),
      stage: Number(m[3]),
      name: Buffer.from(rec.slice(tab + 1), "utf8"),
    });
  }
  entries.sort((a, b) =>
    Buffer.compare(a.name, b.name) !== 0 ? Buffer.compare(a.name, b.name) : a.stage - b.stage,
  );
  const shaBytes = entries.find((c) => c.sha.length === 32) ? 32 : 20;
  const longName = entries.some((c) => c.name.length > 0xfff);
  const fixedLen = 40 + shaBytes + 2;
  const parts = entries.map((c) => {
    const rawLen = fixedLen + c.name.length;
    const e = Buffer.alloc(Math.ceil((rawLen + 1) / 8) * 8);
    e.writeUInt32BE(c.mode, 24);
    c.sha.copy(e, 40);
    e.writeUInt16BE((c.stage << 12) | Math.min(c.name.length, 0xfff), 40 + shaBytes);
    c.name.copy(e, 40 + shaBytes + 2);
    return e;
  });
  const hdr = Buffer.alloc(12);
  hdr.write("DIRC");
  hdr.writeUInt32BE(longName ? 3 : 2, 4);
  hdr.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([hdr, ...parts]);
  const dig = createHash(shaBytes === 32 ? "sha256" : "sha1");
  dig.update(body);
  return Buffer.concat([body, dig.digest()]);
};

const EWAH_EMPTY = Buffer.alloc(12);
const NUL = "\0";
const APPEND_LEN = 1 << 28;
const baseDir2 = (root: string) => {
  const d = mkdtempSync(path.join(os.tmpdir(), "cx31c-aux-"));
  tmpdirs.push(d);
  void root;
  return d;
};

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx31c-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "sub", "payload"), "EVIL\n");
  return root;
};

/**
 * Claims-fd watcher: poll /proc/self/fd for a newborn fd whose first
 * bytes read `DIRC` at the expected length, then append the precomputed
 * tail through a procfs re-open. The verifier's held fd is opened
 * read-only; the inode stays same-UID writable.
 */
const startClaimsFdPatcher = (tailPath: string, pinnedLen: number, secs = 30) => {
  const script =
    "import os,sys,time\n" +
    "tail=open(sys.argv[1],'rb').read(); pinned=int(sys.argv[2]); pid=sys.argv[3]; end=time.time()+float(sys.argv[4]); done=set()\n" +
    "base='/proc/'+pid+'/fd'\n" +
    "while time.time()<end:\n" +
    "    try: fds=os.listdir(base)\n" +
    "    except: time.sleep(0.00002); continue\n" +
    "    for n in fds:\n" +
    "        if n in done: continue\n" +
    "        try:\n" +
    "            fd=os.open(base+'/'+n, os.O_RDONLY)\n" +
    "        except: continue\n" +
    "        try:\n" +
    "            st=os.fstat(fd)\n" +
    "            if st.st_size!=pinned or not st.st_mode&0o100000: os.close(fd); continue\n" +
    "            head=os.pread(fd,4,0)\n" +
    "            os.close(fd)\n" +
    "            if head!=b'DIRC': continue\n" +
    "            w=os.open(base+'/'+n, os.O_RDWR)\n" +
    "            os.pwrite(w,tail,pinned)\n" +
    "            os.close(w)\n" +
    "            done.add(n)\n" +
    "        except: pass\n" +
    "    time.sleep(0.00002)\n";
  const child = spawn(
    "python3",
    ["-c", script, tailPath, String(pinnedLen), String(process.pid), String(secs)],
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

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

describe("CX-r31-C: claims-fd link-tail raced onto the read channel (`unprovenIgnoredPaths`)", () => {
  it(
    "untracked `.gitignore` forged as tracked+clean → `!! sub/payload` called proven — member hidden from statusDirty",
    { timeout: 480_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkRepo();
        // Untracked session rule: `.gitignore` exists ONLY in the
        // worktree (never staged/committed) — honest answer: unproven.
        writeFileSync(path.join(root, ".gitignore"), "sub/\n");
        const wtIgnoreSha = git(root, ["hash-object", "-w", ".gitignore"]);
        // Grind pad name → claims image sha window (H[0] in A-Z +
        // u32be(H[4:8]) inside the append).
        const fSha = git(root, ["rev-parse", ":f.txt"]);
        const padSha = git(root, ["hash-object", "-w", "--stdin"], "P\n");
        const rec = (sha: string, p: string) => `100644 ${sha} 0\t${p}${NUL}`;
        let claimsImg: Buffer | null = null;
        let padName = "";
        let V = 0;
        for (let g = 0; g < 200000; g++) {
          padName = `pad${g}.txt`;
          claimsImg = claimsImageOf(rec(fSha, "f.txt") + rec(padSha, padName));
          V = claimsImg.readUInt32BE(claimsImg.length - 16);
          const h0 = claimsImg[claimsImg.length - 20]!;
          if (h0 >= 0x41 && h0 <= 0x5a && V >= 12 && V <= APPEND_LEN - 68) break;
        }
        expect(V).toBeGreaterThanOrEqual(12);
        writeFileSync(path.join(root, padName), "P\n");
        git(root, ["add", padName]);
        // The forged base adds `.gitignore` as tracked carrying the
        // WORKTREE bytes' sha — claims-side diff sees it clean.
        const baseImg = claimsImageOf(
          rec(wtIgnoreSha, ".gitignore") + rec(fSha, "f.txt") + rec(padSha, padName),
        );
        const baseSha = baseImg.subarray(baseImg.length - 20).toString("hex");
        writeFileSync(path.join(root, ".git", `sharedindex.${baseSha}`), baseImg);
        const pinnedLen = claimsImg!.length;
        const payload = Buffer.concat([
          baseImg.subarray(baseImg.length - 20),
          EWAH_EMPTY,
          EWAH_EMPTY,
        ]);
        const tail = Buffer.alloc(APPEND_LEN - 20);
        tail.write("link", V - 12, "ascii");
        tail.writeUInt32BE(44, V - 8);
        payload.copy(tail, V - 4);
        tail.write("ZZZZ", V + 40, "ascii");
        tail.writeUInt32BE(APPEND_LEN - 68 - V, V + 44);
        const img2 = Buffer.concat([claimsImg!, tail]);
        const full = Buffer.concat([img2, createHash("sha1").update(img2).digest()]);
        const tailPath = path.join(baseDir2(root), "tail.bin");
        writeFileSync(tailPath, full.subarray(pinnedLen));
        const patcher = startClaimsFdPatcher(tailPath, pinnedLen, 25);
        try {
          const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
          // `statusDirty` refuses by THROWING when a subconsultation
          // returns null ("dirty verdict unverifiable") — the flow-side
          // refusal contract, counted alongside `unproven === null`.
          let d: Awaited<ReturnType<typeof statusDirty>> | null = null;
          try {
            d = await statusDirty(root, ambientIo);
          } catch {
            d = null;
          }
          const memberShown = unproven !== null && [...unproven].includes("sub/payload");
          const entriesShow = d?.entries.some((e) => e.slice(3).includes("sub/payload")) ?? false;
          if (unproven === null || d === null) refused++;
          else if (memberShown || entriesShow) honest++;
          else forged++;
        } finally {
          patcher.stop();
        }
      }
      console.log(
        `read-channel claims-fd race: forged=${forged} refused=${refused} honest=${honest}`,
      );
      expect(forged).toBe(0);
    },
  );

  it("control: untracked `.gitignore` — payload IS unproven without the tail", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "sub/\n");
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).not.toBeNull();
    expect([...unproven!]).toContain("sub/payload");
  });
});
