/*
RFC-1616 round-31 independent adversarial probes — candidate commit
8f18df089, exported tree.

CX-r31-D — `reset`'s rev-vs-pathspec ambiguity (verifier-git.ts:4512-4513
+ :4723-4735): `git reset -q <arg>` parses the first non-flag token as a
rev ONLY if it resolves — a same-UID session controls that resolution
twice over (it owns `refs/`), so the caller's `reset -q d` can mean
HEAD-reset-pathspec or rev-reset depending on the planted state. The
coverage child re-derives the parse inside the armed window, so a flip
between op-parse and coverage-parse should read as a refs/ watch event
(pinned tree — `reproveEvidenceSurface` sweeps `refs/` at :3951-3964).

Cases:
  A) `d` = path only (control) → honest pathspec reset.
  B) `d` resolves as a ref at preflight AND a path exists → git's own
     ambiguity check errors the op honestly (exit≠0, no verdict).
  C) `refs/heads/d` planted between preflight and op → refs pin/event →
     refuse.
  D) `d` resolves at preflight (spec becomes `:/`) vs deleted before the
     op — symmetric refuse.
  E) `d` resolves to DIFFERENT commits at op-time vs coverage-time → the
     mid-window ref move must read as drift.
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
  const root = mkdtempSync(path.join(os.tmpdir(), "cx31d-"));
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

/** Flip `refs/heads/d` between nonexistent and a real commit, forever. */
const startRefFlipper = (root: string, secs = 30) => {
  const script =
    "import os,sys,subprocess,time\n" +
    "root=sys.argv[1]; end=time.time()+float(sys.argv[2])\n" +
    "while time.time()<end:\n" +
    "    subprocess.run(['git','-C',root,'update-ref','refs/heads/d','HEAD'],capture_output=True)\n" +
    "    subprocess.run(['git','-C',root,'update-ref','-d','refs/heads/d'],capture_output=True)\n" +
    "    time.sleep(0.0002)\n";
  const child = spawn("python3", ["-c", script, root, String(secs)], { stdio: "ignore" });
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

describe("CX-r31-D: `reset -q <arg>` rev-vs-pathspec under a moving refs domain", () => {
  it("control A: `d` = path only → honest pathspec reset, exit 0, d unstaged", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    git(root, ["add", "d/normal.txt"]);
    const pre = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(0);
    expect(git(root, ["ls-files", "-s"])).not.toContain("d/normal.txt");
  });

  it("control B: `d` = path AND ref at preflight → git errors ambiguous — honest", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    git(root, ["add", "d/normal.txt"]);
    git(root, ["update-ref", "refs/heads/d", "HEAD"]);
    const pre = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "d"], { preflight: pre! });
    // git dies "fatal: ambiguous argument 'd'" — exit≠0 → no coverage
    // verdict is claimed, which is the honest outcome.
    expect(r.exitCode).not.toBe(0);
  });

  it("C/D/E: mid-window ref plant/delete/move on `d` → refuse, never a torn verdict", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    let forged = 0;
    let refused = 0;
    let exit0 = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      const root = mkRepo();
      mkdirSync(path.join(root, "d"), { recursive: true });
      writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
      git(root, ["add", "d/normal.txt"]);
      const pre = await evidenceRepoPreflight(root);
      const flip = startRefFlipper(root, 15);
      try {
        const r = await evidenceAnchoredGit(root, ["reset", "-q", "d"], { preflight: pre! });
        if (r.exitCode === -1) refused++;
        else if (r.exitCode === 0) {
          // A resolved-exit op must have honestly staged-set coverage —
          // verify no phantom entries crept into the real index.
          const out = git(root, ["ls-files", "-s"]);
          if (!out.includes("f.txt")) forged++;
          else exit0++;
        } else exit0++;
      } finally {
        flip.stop();
      }
    }
    console.log(`reset rev/pathspec flip: refused=${refused} exit0=${exit0} forged=${forged}`);
    expect(forged).toBe(0);
  });
});
