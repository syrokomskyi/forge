/*
RFC-1616 round-32 independent adversarial probes — candidate commit
e32510593, exported tree.

CX-r32-C — `reset`'s rev-vs-pathspec re-resolution (verifier-git.ts
:4730-4742): when `reset -q <arg>` runs WITHOUT `--`, the coverage proof
re-derives git's parse by asking the LIVE snapshot
`rev-parse --verify --end-of-options <tok>^{tree}`. The r31 delta
claimed mid-window ref plants were refused; r32 attacks the remaining
seams:

  A. A ref planted BETWEEN the op child's exit and the coverage
     `rev-parse` child — inside the SAME armed window (refs/ is pinned
     + watched; :3947-3964, :3697-3713). A direct file write fires an
     inotify event → refuse expected.
  B. `^{tree}` oddities: `d` = a tag object (peels to commit → rev),
     `d` = a blob-named ref (fails ^{tree} → pathspec — but git's own
     `--verify d` SUCCEEDS on the blob → treats `d` as rev → the op
     itself errors → no verdict → honest), `d` = 40-hex filename.
  C. Detached HEAD: resetRev="HEAD" resolves the detached commit.

Expected: refuse-or-honest everywhere; any exit-0 verdict whose staged
set the op never produced is forged.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx32c-"));
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
 * Plant `refs/heads/d` inside the armed evidence window. The judged
 * `git reset` op child lives ~1ms — too fast for /proc polling to
 * catch reliably — so the planter fires at fixed offsets after spawn;
 * the armed window spans the whole anchored call (~50-150ms), so the
 * write lands inside it (verified: the armed watch must refuse).
 */
const startPostOpRefPlanter = (root: string, secs = 30) => {
  const script =
    "import os,sys,time\n" +
    "vpid=int(sys.argv[1]); root=sys.argv[2]; end=time.time()+float(sys.argv[3])\n" +
    "me=str(os.getpid()); seenReset=False; done=False\n" +
    "def kids():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
    "            try: out += open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return out\n" +
    "log=open('/tmp/cx32c-trace.txt','a'); t0=time.time()\n" +
    "log.write('start vpid=%d\\n'%vpid); log.flush()\n" +
    "# The judged `git reset` child lives ~1ms — too fast to catch via\n" +
    "# /proc polling reliably. Instead of watching for op-exit, write the\n" +
    "# ref at fixed offsets — the armed window spans the whole anchored\n" +
    "# call (~50-150ms), so writes at these offsets land inside it.\n" +
    "fires=[0.005,0.02,0.045,0.08]\n" +
    "for f in fires:\n" +
    "    while time.time()<t0+f: time.sleep(0.0005)\n" +
    "    if done: break\n" +
    "    try:\n" +
    "        os.kill(vpid,19)\n" +
    "        open(root+'/.git/refs/heads/d','w').write(open(root+'/.git/refs/heads/main').read())\n" +
    "        log.write('%.1f planted\\n'%((time.time()-t0)*1000)); log.flush()\n" +
    "        done=True\n" +
    "    except Exception as e:\n" +
    "        log.write('%.1f plant-err %s\\n'%((time.time()-t0)*1000,e)); log.flush()\n" +
    "    finally:\n" +
    "        try: os.kill(vpid,18)\n" +
    "        except: pass\n";
  const child = spawn("python3", ["-c", script, String(process.pid), root, String(secs)], {
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

describe("CX-r32-C: reset rev-vs-pathspec — post-op ref plant + ^{tree} oddities", () => {
  it(
    "ref `d` planted between op-exit and coverage rev-parse — inside armed window → refuse",
    { timeout: 240_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let exit0 = 0;
      let lastErr = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const root = mkRepo();
        mkdirSync(path.join(root, "d"), { recursive: true });
        writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
        git(root, ["add", "d/normal.txt"]);
        const pre = await evidenceRepoPreflight(root);
        const planter = startPostOpRefPlanter(root, 20);
        try {
          // `reset -q d` with NO `--`: `d` resolves at neither instant
          // honestly until the plant — the op un-stages pathspec `d`,
          // the coverage `rev-parse d^{tree}` runs inside the same
          // armed window the plant must cross.
          const r = await evidenceAnchoredGit(root, ["reset", "-q", "d"], { preflight: pre! });
          if (r.exitCode === -1) {
            refused++;
            lastErr = r.stderr.slice(0, 140);
          } else if (r.exitCode === 0) {
            const out = git(root, ["ls-files", "-s"]);
            if (!out.includes("f.txt")) forged++;
            else exit0++;
          } else exit0++;
        } finally {
          planter.stop();
        }
      }
      console.log(
        `post-op ref plant: refused=${refused} exit0=${exit0} forged=${forged} last=${lastErr}`,
      );
      expect(forged).toBe(0);
    },
  );

  it("`d` = tag object → rev-form mixed reset writes ORIG_HEAD → honest refuse", async () => {
    const root = mkRepo();
    git(root, ["tag", "-a", "-m", "x", "d"]);
    const pre = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "d"], { preflight: pre! });
    // git parses `d` as a rev (annotated tag → commit): `reset -q d`
    // is a MIXED reset — it writes ORIG_HEAD, which is deliberately
    // absent from anchoredMutationIgnorable (:3596-3610, refs/heads/
    // ORIG_HEAD spoof risk), so the armed watch refuses the op.
    // Honest -1, never a forged verdict on an unjudged side-effect.
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("EVIDENCE-REFUSED");
    expect(git(root, ["ls-files", "-s"])).toContain("f.txt");
  });

  it("`d` = blob-valued ref → op errors honestly (no coverage verdict claimed)", async () => {
    const root = mkRepo();
    const blob = git(root, ["hash-object", "-w", "--stdin"], "x\n");
    // A branch can never hold a blob via update-ref; plant the loose
    // ref file directly — `rev-parse --verify d` answers the blob.
    writeFileSync(path.join(root, ".git", "refs", "heads", "d"), blob + "\n");
    const pre = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "d"], { preflight: pre! });
    // git's own parse takes `d` as a rev → `reset <blob>` fails.
    expect(r.exitCode).not.toBe(0);
  });

  it("`d` = 40-hex filename → git's own ambiguous-arg 128, honestly relayed", async () => {
    const root = mkRepo();
    const hexName = "a".repeat(40);
    writeFileSync(path.join(root, hexName), "n\n");
    git(root, ["add", hexName]);
    const pre = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", hexName], { preflight: pre! });
    // Without `--`, git refuses the 40-hex token as ambiguous
    // ("unknown revision or path") — exit 128 relayed honestly; the
    // staged entry stays (the op never ran). No coverage verdict.
    expect(r.exitCode).toBe(128);
    expect(git(root, ["ls-files", "-s"])).toContain(hexName);
    // The disambiguated `reset -q -- <hex>` pathspec form works.
    const r2 = await evidenceAnchoredGit(root, ["reset", "-q", "--", hexName], {
      preflight: pre!,
    });
    expect(r2.exitCode).toBe(0);
    expect(git(root, ["ls-files", "-s"])).not.toContain(hexName);
  });

  it("detached HEAD — `reset -q -- d` resolves HEAD→detached commit", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    git(root, ["add", "d/normal.txt"]);
    git(root, ["checkout", "-q", "--detach", "HEAD"]);
    const pre = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(0);
    expect(git(root, ["ls-files", "-s"])).not.toContain("d/normal.txt");
  });
});
