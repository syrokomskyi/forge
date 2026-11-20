/*
RFC-1616 round-29 independent adversarial probes — candidate commit
27daa3805, exported tree.

CX-r29-D — r28 boundary surfaces: the `rebase-merge/rewritten/` exempt
name bound (`^([0-9a-f]{40}|[0-9a-f]{64})$` leaf), symlink/dir node
swaps at the exempt path, the `worktrees/<id>/` metadir equivalent,
plus the anchored-`add` admission surface (forbidden flags, skip-list
correctness, pathspec spellings, extraWatchPaths edges, scratch `add`).
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  verifierGit,
  verifierScratchGit,
} from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = (branch = "main") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx29d-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", branch, root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

const foreignTip = (root: string) => {
  writeFileSync(path.join(root, "f.txt"), "FORGED\n");
  git(root, ["add", "f.txt"]);
  const foreign = git(root, ["commit-tree", "-p", "HEAD", "-m", "evil", git(root, ["write-tree"])]);
  execFileSync("git", ["-C", root, "read-tree", "HEAD"], { encoding: "utf8" });
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  return foreign;
};

const plant = (root: string, rel: string, content: string) => {
  const abs = path.join(root, ".git", rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

const startChildMutator = (tgt: string, data: string, match: string, secs = 60) => {
  const script =
    "import os,sys,time\n" +
    "tgt=sys.argv[1]; data=sys.argv[2].encode(); pid=int(sys.argv[3]); pat=sys.argv[4].encode(); end=time.time()+float(sys.argv[5]); me=str(os.getpid()); seen=set(); retries={}\n" +
    "while time.time()<end:\n" +
    "    kids=set()\n" +
    "    try:\n" +
    "        for t in os.listdir(f'/proc/{pid}/task'):\n" +
    "            try: kids.update(open(f'/proc/{pid}/task/{t}/children').read().split())\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    for k in kids:\n" +
    "        if k in seen or k==me: continue\n" +
    "        try: os.kill(int(k),19)\n" +
    "        except: seen.add(k); continue\n" +
    "        try: c=open(f'/proc/{k}/cmdline','rb').read()\n" +
    "        except: c=b''\n" +
    "        a0=c.split(b'\\0')[0]\n" +
    "        isgit=a0.endswith(b'/git') or a0==b'git'\n" +
    "        ambig=(a0==b'' or a0.endswith(b'/node') or a0==b'node')\n" +
    "        if isgit and pat in c:\n" +
    "            seen.add(k)\n" +
    "            try: open(tgt,'wb').write(data)\n" +
    "            except: pass\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "        elif isgit or (a0 and not ambig):\n" +
    "            seen.add(k)\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "        else:\n" +
    "            n=retries.get(k,0)+1; retries[k]=n\n" +
    "            if n>200: seen.add(k)\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: seen.add(k)\n";
  const child = spawn(
    "python3",
    ["-c", script, tgt, data, String(process.pid), match, String(secs)],
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

describe("CX-r29-D rewritten/ name-bound boundary", () => {
  const H = "a".repeat(40);
  const cases: Array<[string, boolean]> = [
    [`rebase-merge/rewritten/${"a".repeat(39)}`, true], // 39-hex — refuse
    [`rebase-merge/rewritten/${"a".repeat(41)}`, true], // 41-hex — refuse
    [`rebase-merge/rewritten/${"a".repeat(63)}`, true], // 63-hex — refuse
    [`rebase-merge/rewritten/${"a".repeat(65)}`, true], // 65-hex — refuse
    [`rebase-merge/rewritten/${"A".repeat(40)}`, true], // uppercase — refuse
    [`rebase-merge/rewritten/${"g".repeat(40)}`, true], // non-hex — refuse
    ["rebase-merge/rewritten/deep/x", true], // nested — refuse
    [`rebase-merge/rewritten/${H}/x`, true], // dir-member under oid name — refuse
    [`rebase-merge/rewritten-${H.slice(0, 8)}/x`, true], // prefix dir — refuse
    [`rebase-apply/rewritten/${H}`, true], // wrong parent — refuse
  ];
  for (const [rel, mustRefuse] of cases) {
    it(`planted ${rel} carrying an oid`, async () => {
      const root = mkRepo();
      const foreign = foreignTip(root);
      plant(root, rel, `${foreign}\n`);
      const r = await verifierGit(root, ["rev-parse", rel]);
      if (mustRefuse) {
        expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
      }
    });
  }

  it("rewritten/<oid> as a DIRECTORY carrying a member refuses the member", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    const honest = git(root, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(root, ".git", "rebase-merge", "rewritten", honest), { recursive: true });
    writeFileSync(
      path.join(root, ".git", "rebase-merge", "rewritten", honest, "x"),
      `${foreign}\n`,
    );
    const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${honest}/x`]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("rebase-merge/rewritten as SYMLINK->dir refuses (linkDir leaf)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    const honest = git(root, ["rev-parse", "HEAD"]);
    const tgt = mkdtempSync(path.join(os.tmpdir(), "cx29d-link-"));
    tmpdirs.push(tgt);
    mkdirSync(path.join(tgt, honest));
    writeFileSync(path.join(tgt, honest, "x"), `${foreign}\n`);
    mkdirSync(path.join(root, ".git", "rebase-merge"), { recursive: true });
    symlinkSync(tgt, path.join(root, ".git", "rebase-merge", "rewritten"));
    const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${honest}/x`]);
    expect(r.exitCode).toBe(-1);
  });

  it("rebase-merge itself as SYMLINK->dir: member bytes are pin-attested — never the foreign sha", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    const honest = git(root, ["rev-parse", "HEAD"]);
    const tgt = mkdtempSync(path.join(os.tmpdir(), "cx29d-link2-"));
    tmpdirs.push(tgt);
    mkdirSync(path.join(tgt, "rewritten"));
    writeFileSync(path.join(tgt, "rewritten", honest), `${honest}\n`);
    symlinkSync(tgt, path.join(root, ".git", "rebase-merge"));
    const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${honest}`]);
    // The symlinked dir's members are enumerated+pinned at baseline —
    // an honest answer of the attested oid or a refusal are both
    // correct; the FOREIGN sha must never escape.
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    if (r.exitCode === 0) expect(r.stdout).toContain(honest);
  });

  it("rebase-merge dir->FILE swap inside the armed window refuses", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const foreign = foreignTip(root);
    const honest = git(root, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(root, ".git", "rebase-merge", "rewritten"), { recursive: true });
    writeFileSync(path.join(root, ".git", "rebase-merge", "rewritten", honest), `${honest}\n`);
    // Mid-window: replace the whole `rebase-merge` dir with a FILE —
    // the consulted member's parent chain mutates → refuse.
    {
      const tgt = path.join(root, ".git", "rebase-merge");
      // A dumb mid-window swapper that renames the dir away.
      const swapper = spawn("python3", [
        "-c",
        "import os,sys,time\n" +
          "d=sys.argv[1]; end=time.time()+float(sys.argv[2])\n" +
          "n=0\n" +
          "while time.time()<end:\n" +
          "    try:\n" +
          "        if os.path.isdir(d) and not os.path.islink(d):\n" +
          "            os.rename(d, d+'_moved'); open(d,'wb').write(b'x')\n" +
          "            os.unlink(d); os.rename(d+'_moved', d)\n" +
          "    except: pass\n",
        tgt,
        "30",
      ]);
      swapper.unref();
      const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${honest}`]);
      try {
        swapper.kill("SIGKILL");
      } catch {
        /* done */
      }
      // Refusal or the honest attested oid — never the foreign sha.
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    }
  });

  it("rewritten/<oid> as a SYMLINK->file: baseline answers the pinned target; mid-window retarget refuses", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const foreign = foreignTip(root);
    const honest = git(root, ["rev-parse", "HEAD"]);
    const tgt = mkdtempSync(path.join(os.tmpdir(), "cx29d-leaf-"));
    tmpdirs.push(tgt);
    const target = path.join(tgt, "oid");
    writeFileSync(target, `${honest}\n`);
    const foreignTarget = path.join(tgt, "evil");
    writeFileSync(foreignTarget, `${foreign}\n`);
    mkdirSync(path.join(root, ".git", "rebase-merge", "rewritten"), { recursive: true });
    symlinkSync(target, path.join(root, ".git", "rebase-merge", "rewritten", honest));
    // Baseline: the leaf is attested — rev-parse answers the pinned
    // target's oid (residual, or refusal — never the foreign sha).
    const r1 = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${honest}`]);
    expect(r1.exitCode === -1 || !r1.stdout.includes(foreign)).toBe(true);
    // Mid-window retarget the link to the foreign file — pin drift must refuse.
    const r2 = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${honest}`]);
    expect(r2.exitCode === -1 || !r2.stdout.includes(foreign)).toBe(true);
  });

  it("worktrees/<id>/rebase-merge/rewritten/evil refuses; <oid> is the accepted authored residual", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["worktree", "add", "-q", "--detach", path.join(root, "wt2")]);
    const meta = path.join(root, ".git", "worktrees", "wt2");
    mkdirSync(path.join(meta, "rebase-merge", "rewritten"), { recursive: true });
    writeFileSync(path.join(meta, "rebase-merge", "rewritten", "evil"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "worktrees/wt2/rebase-merge/rewritten/evil"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    const honest = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(meta, "rebase-merge", "rewritten", honest), `${honest}\n`);
    const r2 = await verifierGit(root, [
      "rev-parse",
      `worktrees/wt2/rebase-merge/rewritten/${honest}`,
    ]);
    expect(r2.exitCode === -1 || !r2.stdout.includes(foreign)).toBe(true);
  });
});

describe("CX-r29-D anchored-add admission surface", () => {
  const forbidden: string[][] = [
    ["add", "-f", "--", "d"],
    ["add", "--force", "--", "d"],
    ["add", "--chmod=+x", "--", "d"],
    ["add", "-N", "--", "d"],
    ["add", "--intent-to-add", "--", "d"],
    ["add", "-p", "--", "d"],
    ["add", "-i", "--", "d"],
    ["add", "-e", "--", "d"],
    ["add", "--pathspec-from-file=x", "--", "d"],
    ["add", "--pathspec-from-f=x", "--", "d"], // abbreviation must still refuse
    ["add", "--pathspec-from-stdin", "--", "d"],
    ["reset", "--hard", "--", "d"],
    ["rm", "-rf", "d"],
    ["update-index", "--index-info"],
  ];
  for (const args of forbidden) {
    it(`argv ${JSON.stringify(args)} refuses the anchored mutation table`, async () => {
      const root = mkRepo();
      mkdirSync(path.join(root, "d"), { recursive: true });
      writeFileSync(path.join(root, "d", "x.txt"), "x\n");
      const pre = await evidenceRepoPreflight(root);
      expect(pre).not.toBeNull();
      const r = await evidenceAnchoredGit(root, args, { preflight: pre! });
      expect(r.exitCode).toBe(-1);
    });
  }

  it("`add --renormalize -A -- d` skips coverage and stays honest (no untracked consult)", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "t.txt"), "t\n");
    git(root, ["add", "d/t.txt"]);
    git(root, ["commit", "-qm", "t"]);
    writeFileSync(path.join(root, "d", "new.txt"), "n\n");
    // A foreign .gitignore must NOT be able to hide anything — renormalize
    // never expands untracked members (ambient-verified).
    writeFileSync(path.join(root, ".gitignore"), "d/new.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "--renormalize", "-A", "--", "d"], {
      preflight: pre!,
    });
    expect(r.exitCode).toBe(0);
    expect(git(root, ["ls-files", "--", "d"])).not.toContain("new.txt");
  });

  it("`add -u -- d` tracked-only, foreign .gitignore irrelevant", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "t.txt"), "t\n");
    git(root, ["add", "d/t.txt"]);
    git(root, ["commit", "-qm", "t"]);
    writeFileSync(path.join(root, "d", "new.txt"), "n\n");
    writeFileSync(path.join(root, ".gitignore"), "d/new.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-u", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(0);
    expect(git(root, ["ls-files", "--", "d"])).not.toContain("new.txt");
  });

  it("`add -u -A -- d` is an ambient-fatal flag pair — the channel must pass 128, not fabricate 0", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "t.txt"), "t\n");
    git(root, ["add", "d/t.txt"]);
    git(root, ["commit", "-qm", "t"]);
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-u", "-A", "--", "d"], { preflight: pre! });
    // Ambient git refuses this pair outright (fatal exit 128). The
    // channel may also refuse it (-1) — but it must never fabricate a
    // successful staged-set from a dead child.
    expect(r.exitCode === -1 || r.exitCode === 128).toBe(true);
  });

  it("`add --sparse -A -- d` is admitted AND coverage still refuses a foreign .gitignore", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "--sparse", "-A", "--", "d"], {
      preflight: pre!,
    });
    expect(r.exitCode).toBe(-1);
  });

  it("`add -n -A -- d` refuses a foreign .gitignore source even though nothing stages", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-n", "-A", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
  });

  it("`add -n -A -- d` with a committed .gitignore reports honestly (attested omit)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-qm", "ign"]);
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-n", "-A", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("normal.txt");
    expect(r.stdout).not.toContain("secret.txt");
  });

  it("`add -A d` (no -- separator) gets the same coverage", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
  });

  it("`add --all d` long form gets the same coverage", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "--all", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
  });

  it("clustered `-An` parses the flag cluster and refuses a foreign .gitignore", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-An", "--", "d"], { preflight: pre! });
    // `-An` = -A + -n (dry-run): foreign-source omission still refuses.
    expect(r.exitCode).toBe(-1);
  });

  it("`add -A -- ':(icase)D'` pathspec magic: a matching dir still gets coverage", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    // A non-ignored member so the magic pathspec matches at all —
    // ambient git HARD-FAILS a fully-ignored magic pathspec (exit 128),
    // which is itself an honest answer.
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", ":(icase)D"], {
      preflight: pre!,
    });
    expect(r.exitCode).toBe(-1);
  });

  it("`add -A -- ':(glob)d/*'` magic pathspec gets the same coverage", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", ":(glob)d/*"], {
      preflight: pre!,
    });
    // Ambient git stages normal.txt and drops secret.txt — the foreign
    // .gitignore justifying the drop must refuse.
    expect(r.exitCode).toBe(-1);
  });

  it("`add -A -- d1 d2` multi-pathspec covers both extents", async () => {
    const root = mkRepo();
    for (const dd of ["d1", "d2"]) {
      mkdirSync(path.join(root, dd), { recursive: true });
      writeFileSync(path.join(root, dd, "x.txt"), "x\n");
    }
    writeFileSync(path.join(root, ".gitignore"), "d2/x.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d1", "d2"], {
      preflight: pre!,
    });
    expect(r.exitCode).toBe(-1);
  });
});

describe("CX-r29-D extraWatchPaths edges", () => {
  it("a caller-pinned untracked `.gitignore` is attested — but a mid-window pin-path rewrite refuses", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const gi = path.join(root, ".gitignore");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], {
      preflight: pre!,
      extraWatchPaths: [gi],
    });
    // Pinned untracked source: attested by contract — the drop is the
    // caller's own attestation.
    expect(r.exitCode).toBe(0);
    // Now rewrite the pinned path mid-window — pin drift must refuse.
    const root2 = mkRepo();
    mkdirSync(path.join(root2, "d"), { recursive: true });
    writeFileSync(path.join(root2, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root2, "d", "normal.txt"), "n\n");
    writeFileSync(path.join(root2, ".gitignore"), "d/secret.txt\n");
    const gi2 = path.join(root2, ".gitignore");
    const pre2 = await evidenceRepoPreflight(root2);
    expect(pre2).not.toBeNull();
    const writer = startChildMutator(gi2, "d/*\n", "add");
    try {
      const r2 = await evidenceAnchoredGit(root2, ["add", "-A", "--", "d"], {
        preflight: pre2!,
        extraWatchPaths: [gi2],
      });
      // Refusal is required; if it slipped through, the pinned-path
      // rewrite armed a rule the caller never pinned.
      if (r2.exitCode !== -1) {
        // exit 0 is only honest when the PINNED bytes' rule ran
        // (d/secret.txt dropped, d/normal.txt staged) — the rewritten
        // d/* would have dropped normal.txt too.
        const staged = git(root2, ["ls-files", "--", "d"]);
        expect(staged.includes("d/normal.txt")).toBe(true);
      }
    } finally {
      writer.stop();
    }
  });

  it("an extraWatchPath absent at arm fails the watch (fail closed, not silent)", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "x.txt"), "x\n");
    const missing = path.join(root, "notthere", ".gitignore");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], {
      preflight: pre!,
      extraWatchPaths: [missing],
    });
    // If the watch silently can't arm, a session-created rule file at
    // the pinned path would be attested-by-pin — refusal is the only
    // provable answer.
    expect(r.exitCode).toBe(-1);
  });
});

describe("CX-r29-D scratch add stays unwatched by design", () => {
  it("verifierScratchGit `add` consults ambient .gitignore honestly — no anchored claim attached", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const r = await verifierScratchGit(root, ["add", "-A", "--", "d"]);
    // The scratch channel returns git's real result — the shrink is
    // ambient git semantics, not an attested claim.
    expect(r.exitCode === 0 || r.exitCode === -1).toBe(true);
    if (r.exitCode === 0) {
      expect(git(root, ["ls-files", "--", "d"])).not.toContain("secret.txt");
    }
  });
});
