/*
RFC-1616 round-30 independent adversarial probes — candidate commit
027cf64e4, exported tree.

CX-r30-A — flow-side `unprovenIgnoredPaths` rule-source provenance is a
PATH check, never a BYTES check. `statusDirty` proves each `!!` claim by
`check-ignore -v -z` citing a `.gitignore` that is TRACKED in the claims
index (`trackedSet.has(src)`). The tracked source's worktree bytes are
folded into `extraWatchPaths` — but that pin only arms for the
`check-ignore` child's own lifetime, so whatever bytes exist at arm time
are the attested baseline. NOTHING on this side ever compares the
worktree `.gitignore` bytes to the claims-index entry — the claims-index
`status` clean check exists only in `verifyAnchoredMutationCoverage`
(verifier-git.ts:4835-4851), not here (verifier-git.ts:5396-5434).

Attack shape (all moves land BETWEEN verifier children, inside no armed
window):

  t0   tracked `.gitignore` = `x` (clean, committed); `sub/.gitignore`
       = `*` (untracked — hides itself and `sub/payload`).

  1.   `status --porcelain -uall` child reports `!! sub/.gitignore`,
       `!! sub/payload`, and a CLEAN `.gitignore` — no ` M` anywhere.
  2.   The instant that child exits (same-UID /proc children watch):
       `rm sub/.gitignore` (the fs walk in `sessionIgnoreRulePaths`
       then finds no session-authored rule source) and append `sub/`
       to the tracked root `.gitignore`.
  3.   `check-ignore -v -z` now cites `.gitignore` — trackedSet has it,
       its post-flip inode is the armed baseline — both `!!` claims
       stay "proven" and never rejoin the verdict.

Result: `statusDirty` returns `entries: []` — a fully CLEAN verdict on a
worktree that still holds the untracked `sub/payload` payload. The
` M .gitignore` the residual note contemplates never reaches a consult:
the only `status` child ran before the flip. The hidden-member class the
provenance requirement was built to cover is forged outright.

Fix: `unprovenIgnoredPaths` now binds the CONSULTED bytes, not the cited
path — every tracked source is stat-pinned before the `check-ignore`
child (ctime is kernel-managed, so flip-then-restore still drifts), a
whole-tree `diff --name-only` on the claims index lists the
worktree-vs-blob divergent set (no pathspec trust — a source named with
`:(` magic cannot scope the query away from itself), and each cited
source must be clean AND stat-stable or its `!!` joins `unproven`.
A refused or failed `check-ignore`/`diff` child returns `null` —
channel refusal, never silent.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { statusDirty } from "../../flow/git.ts";
import { ambientIo } from "../../../src/utils/io.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx30a-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, ".gitignore"), "x\n");
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/**
 * /proc-children trigger: wait until a git child whose cmdline contains
 * `match` has appeared AND exited, then run `hook` once (a python-eval
 * performing the two worktree ops). The ops land in the window between
 * the `status` child and the `sessionIgnoreRulePaths` fs walk /
 * `check-ignore` spawn — inside no armed watch.
 */
const startPostStatusFlipper = (match: string, hookArgv: string[], secs = 60) => {
  const script =
    "import os,sys,time\n" +
    "pid=int(sys.argv[1]); pat=sys.argv[2].encode(); hook=sys.argv[3:]; end=time.time()+float(os.environ.get('SECS','60')); me=str(os.getpid())\n" +
    "seen={}; fired=False\n" +
    "while time.time()<end and not fired:\n" +
    "    kids=set()\n" +
    "    try:\n" +
    "        for t in os.listdir(f'/proc/{pid}/task'):\n" +
    "            try: kids.update(open(f'/proc/{pid}/task/{t}/children').read().split())\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    for k in kids:\n" +
    "        if k==me: continue\n" +
    "        try: c=open(f'/proc/{k}/cmdline','rb').read()\n" +
    "        except: c=b''\n" +
    "        a0=c.split(b'\\0')[0]\n" +
    "        isgit=a0.endswith(b'/git') or a0==b'git'\n" +
    "        if isgit and pat in c: seen[k]=True\n" +
    "    for k in list(seen):\n" +
    "        if not os.path.exists(f'/proc/{k}'):\n" +
    "            import subprocess\n" +
    "            try: subprocess.call(hook)\n" +
    "            except Exception: pass\n" +
    "            fired=True; break\n" +
    "    time.sleep(0.00005)\n";
  const child = spawn("python3", ["-c", script, String(process.pid), match, ...hookArgv], {
    stdio: "ignore",
    env: { ...process.env, SECS: String(secs) },
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

describe("CX-r30-A: flow-side `!!` provenance attests tracked PATH, not consulted BYTES", () => {
  it(
    "a tracked `.gitignore` flipped between the status and check-ignore " +
      "children hides an untracked payload behind a 'tracked' source — clean verdict on a dirty tree",
    { timeout: 180_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 12 && forged === 0; attempt++) {
        const root = mkRepo();
        mkdirSync(path.join(root, "sub"), { recursive: true });
        // Untracked self-hiding rule source — `*` covers itself too.
        writeFileSync(path.join(root, "sub", ".gitignore"), "*\n");
        writeFileSync(path.join(root, "sub", "payload"), "EVIL\n");
        // The flip program: delete the session rule source, then append
        // a covering rule to the TRACKED root .gitignore. Both ops land
        // between verifier children — no armed window sees them.
        const flip = startPostStatusFlipper("--porcelain", [
          "python3",
          "-c",
          `import os; os.unlink('${root}/sub/.gitignore'); open('${root}/.gitignore','a').write('sub/\\n')`,
        ]);
        try {
          const d = await statusDirty(root, ambientIo);
          const payloadHidden = !d.entries.some((e) => e.includes("sub/payload"));
          if (d.entries.length === 0 && d.toleratedState.length === 0 && payloadHidden) forged++;
          else if (payloadHidden)
            refused++; // dirt listed but member still hidden
          else honest++;
        } catch {
          refused++; // thrown = unverifiable → honest refusal direction
        } finally {
          flip.stop();
        }
      }
      console.log(`statusDirty flip: forged=${forged} refused=${refused} honest=${honest}`);
      expect(forged).toBe(0);
    },
  );

  it("control: without the mid-sequence flip the same tree reports its dirt", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "sub", ".gitignore"), "*\n");
    writeFileSync(path.join(root, "sub", "payload"), "EVIL\n");
    const d = await statusDirty(root, ambientIo);
    expect(d.entries.length).toBeGreaterThan(0);
    expect(d.entries.some((e) => e.includes("sub/payload") || e.includes("sub/.gitignore"))).toBe(
      true,
    );
  });

  it("control: a pre-call dirty tracked `.gitignore` lists ` M` dirt — the accepted residual", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "sub"), { recursive: true });
    appendFileSync(path.join(root, ".gitignore"), "sub/\n");
    writeFileSync(path.join(root, "sub", "payload"), "EVIL\n");
    const d = await statusDirty(root, ambientIo);
    // The dirty source shows as ` M .gitignore`; sub/payload stays
    // hidden behind the tracked source (known-accepted member-level
    // residual — the top-level verdict is still dirty).
    expect(d.entries.some((e) => e.includes(".gitignore"))).toBe(true);
  });
});
