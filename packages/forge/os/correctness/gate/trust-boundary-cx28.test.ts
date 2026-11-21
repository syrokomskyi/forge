/*
RFC-1616 round-28 independent adversarial probes — candidate commit
299647718, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.

Round-28 findings:

  CX-r28-A — `rebase-merge/rewritten/` authored-position prefix
    over-match: the consult judge exempts oid-shaped content at
    `surface.startsWith("rebase-merge/rewritten/")` — unbounded on the
    name AND depth. Real `git rebase` bookkeeping writes only FLAT
    OID-NAMED files there (`rewritten/<old-oid>` carrying `<new-oid>`),
    but a planted `.git/rebase-merge/rewritten/evil` or
    `.../rewritten/<dir>/<name>` file holding `<foreign-sha>` is
    attested as baseline and resolves through git's `$GIT_DIR/<name>`
    dwim — `rev-parse rebase-merge/rewritten/evil` answers the foreign
    rev on every channel, `log`/`cat-file`/`showMany` serve foreign
    history/bytes, and the anchored `reset -q <rev> -- <paths>` stages
    the foreign blob. CONFIRMED LIVE (git 2.53 resolves every
    rewritten/* path ambiently).

    Fix: the exempt name bound is the shape git itself produces —
    `rebase-merge/rewritten/<40..64-hex>` exactly, nothing deeper and
    no non-oid name — so `rewritten/evil` and `rewritten/<dir>/<name>`
    are `check` positions like every other never-authored leaf.

  CX-r28-B — `evidenceAnchoredGit add -A -- <dir>` silently drops
    session-ignored members: `git add -A` on a directory pathspec skips
    ignored members with exit 0 (explicit FILE pathspecs fail honestly,
    verified ambiently). A planted worktree `.gitignore` (never judged
    — CX-142 judged them for status reads only) reshapes the staged
    set while the channel reports success, so callers counting staged
    paths (archive-regen: `staged: movedPaths.length`) fabricate the
    staging claim. Live for directory pathspecs and bare `-A`.

    Fix: `verifyAnchoredAddCoverage` runs inside the still-armed window
    post-spawn — every residual untracked path under the judged
    pathspec must trace via `check-ignore -v` to an ATTESTED source
    (tracked in the pre-op claims index AND worktree-clean against it,
    or caller-pinned through the new `extraWatchPaths` opt), and every
    newly-staged path must NOT be attested-ignored. A drop with no
    justification or a foreign source refuses before the verdict
    escapes; `-n`/`--dry-run` refuses only foreign-source omissions
    (no-source residuals are honest report entries), and
    tracked-only ops (`-u`/`--update`/`--unmerged`/`--refresh`/
    `--renormalize`) skip — no ignore consult can shrink their set.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  verifierGit,
  verifierScratchGit,
} from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = (branch = "main") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx28-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", branch, root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/** A commit the caller never merged — carries a DIFFERENT f.txt blob. */
const foreignTip = (root: string) => {
  writeFileSync(path.join(root, "f.txt"), "FORGED\n");
  git(root, ["add", "f.txt"]);
  const foreign = git(root, ["commit-tree", "-p", "HEAD", "-m", "evil", git(root, ["write-tree"])]);
  execFileSync("git", ["-C", root, "read-tree", "HEAD"], { encoding: "utf8" });
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  return foreign;
};

/** Plant content at a nested gitdir path (non-member position). */
const plant = (root: string, rel: string, content: string) => {
  const abs = path.join(root, ".git", rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

const mkfifo = (p: string) => execFileSync("mkfifo", [p]);

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/**
 * /proc-children watcher (CX-r27-B primitive, mode-parameterized): a
 * persistent poller — the instant a git child of this process whose
 * argv contains `match` appears, SIGSTOP it (frozen wherever it is —
 * almost always before its own open() of the consulted surface), apply
 * the mutation (write/append `data` at `tgt`, or exec `cmd`), SIGCONT.
 * The mutation lands deterministically inside the judged child's
 * lifetime — the pre-spawn reprove already passed.
 */
const startChildMutator = (
  tgt: string,
  data: string,
  match: string,
  mode: "wb" | "ab" = "wb",
  secs = 300,
) => {
  const script =
    "import os,sys,time\n" +
    "tgt=sys.argv[1]; data=sys.argv[2].encode(); pid=int(sys.argv[3]); pat=sys.argv[4].encode(); end=time.time()+float(sys.argv[5]); me=str(os.getpid()); mode=sys.argv[6]; seen=set(); retries={}\n" +
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
    "            try: open(tgt,mode).write(data)\n" +
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
    ["-c", script, tgt, data, String(process.pid), match, String(secs), mode],
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

describe("CX-r28-A: rebase-merge/rewritten/ authored prefix over-match", () => {
  it("sanity: ambient git resolves rebase-merge/rewritten/{evil, deep/FOO, <oid>} via dwim", () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "HEAD"]);
    plant(root, "rebase-merge/rewritten/evil", `${honest}\n`);
    plant(root, "rebase-merge/rewritten/deep/FOO", `${honest}\n`);
    plant(root, `rebase-merge/rewritten/${honest}`, `${honest}\n`);
    expect(git(root, ["rev-parse", "rebase-merge/rewritten/evil"])).toBe(honest);
    expect(git(root, ["rev-parse", "rebase-merge/rewritten/deep/FOO"])).toBe(honest);
    expect(git(root, ["rev-parse", `rebase-merge/rewritten/${honest}`])).toBe(honest);
  });

  it("a planted .git/rebase-merge/rewritten/evil oid answers verifierGit rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "rebase-merge/rewritten/evil", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "rebase-merge/rewritten/evil"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a planted .git/rebase-merge/rewritten/deep/FOO oid answers verifierGit rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "rebase-merge/rewritten/deep/FOO", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "rebase-merge/rewritten/deep/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a planted .git/rebase-merge/rewritten/evil oid answers gitEvidence rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "rebase-merge/rewritten/evil", `${foreign}\n`);
    const r = await gitEvidence(root, ["rev-parse", "rebase-merge/rewritten/evil"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a planted .git/rebase-merge/rewritten/evil oid answers verifierScratchGit rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "rebase-merge/rewritten/evil", `${foreign}\n`);
    const r = await verifierScratchGit(root, ["rev-parse", "rebase-merge/rewritten/evil"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a planted rewritten/evil oid fabricates log history — gitEvidence log -1 serves the foreign tip", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "rebase-merge/rewritten/evil", `${foreign}\n`);
    const r = await gitEvidence(root, ["log", "-1", "--format=%H", "rebase-merge/rewritten/evil"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a planted rewritten/deep/FOO oid serves cat-file forged commit bytes", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "rebase-merge/rewritten/deep/FOO", `${foreign}\n`);
    const r = await verifierGit(root, ["cat-file", "commit", "rebase-merge/rewritten/deep/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes("evil")).toBe(true);
  });

  it("a planted rewritten/evil oid steers the anchored reset — foreign blob staged", async () => {
    const root = mkRepo();
    const honestBlob = git(root, ["rev-parse", "HEAD:f.txt"]);
    const foreign = foreignTip(root);
    const forgedBlob = git(root, ["rev-parse", `${foreign}:f.txt`]);
    plant(root, "rebase-merge/rewritten/evil", `${foreign}\n`);
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(
      root,
      ["reset", "-q", "rebase-merge/rewritten/evil", "--", "f.txt"],
      { preflight: pre! },
    );
    if (r.exitCode === -1 || r.exitCode !== 0) return;
    const staged = git(root, ["ls-files", "-s", "f.txt"]);
    expect(staged.includes(forgedBlob) === false && staged.includes(honestBlob)).toBe(true);
  });

  it("a planted rewritten/evil oid answers the origin channel forged (run + showMany)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "rebase-merge/rewritten/evil", `${foreign}\n`);
    const origin = createOriginGit(root);
    const r = await origin.run(["rev-parse", "rebase-merge/rewritten/evil"]);
    expect(r === null || r.trim() !== foreign).toBe(true);
    const b = await origin.showMany?.(["rebase-merge/rewritten/evil:f.txt"]);
    expect(b == null || b[0] !== "FORGED\n").toBe(true);
  });

  it("a planted rewritten/evil oid inside a linked-worktree metadir answers verifierGit forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["worktree", "add", "-q", "--detach", path.join(root, "wt2")]);
    const meta = path.join(root, ".git", "worktrees", "wt2");
    mkdirSync(path.join(meta, "rebase-merge", "rewritten"), { recursive: true });
    writeFileSync(path.join(meta, "rebase-merge", "rewritten", "evil"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "worktrees/wt2/rebase-merge/rewritten/evil"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a planted rewritten/evil oid steers merge-base --is-ancestor — verifierGit answers forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root); // child of HEAD → HEAD IS its ancestor
    const head = git(root, ["rev-parse", "HEAD"]);
    // Swap-resolve: `anc` serves foreign, `desc` serves head →
    // --is-ancestor(foreign, head) = 1 (not-ancestor) — the honest 0
    // (rev-unresolvable → 128 or the real relationship) flips.
    plant(root, "rebase-merge/rewritten/anc", `${foreign}\n`);
    plant(root, "rebase-merge/rewritten/desc", `${head}\n`);
    const r = await verifierGit(root, [
      "merge-base",
      "--is-ancestor",
      "rebase-merge/rewritten/anc",
      "rebase-merge/rewritten/desc",
    ]);
    // Forged resolution answers 1 or 0 — only refusal (-1) or a genuine
    // unresolvable fatal (128) is honest.
    expect(r.exitCode === -1 || r.exitCode === 128).toBe(true);
  });

  // Controls — the exemption must stay bound to the shape git itself
  // produces, and every non-exempt spelling must refuse.
  it("control: rebase-merge/rewritten/<oid-named> file is a legit authored position (residual answers)", async () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "HEAD"]);
    plant(root, `rebase-merge/rewritten/${honest}`, `${honest}\n`);
    const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${honest}`]);
    // Residual: git produces this shape, so answering it is the
    // attested-baseline contract — refusal is also acceptable; what
    // must NEVER happen is a silent forged answer (impossible here).
    expect(r.exitCode === 0 || r.exitCode === -1 || r.exitCode === 128).toBe(true);
  });

  it("control: rebase-merge/rewritten-evil/x does NOT match the prefix — refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "rebase-merge/rewritten-evil/x", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "rebase-merge/rewritten-evil/x"]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("control: rebase-merge/rewritten as a FILE (no trailing slash) refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "rebase-merge"), { recursive: true });
    writeFileSync(path.join(root, ".git", "rebase-merge", "rewritten"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "rebase-merge/rewritten"]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("control: symref content at rewritten/evil refuses even though oid content slips (asymmetry = the hole)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "rebase-merge/rewritten/evil", "ref: refs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "rebase-merge/rewritten/evil"]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("control: x/rebase-merge/rewritten/evil (nested position) refuses — only top-level rebase-merge exempts", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "x/rebase-merge/rewritten/evil", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "x/rebase-merge/rewritten/evil"]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("control: authored exact-name positions answer residual (onto / rewritten-list / sequencer/head)", async () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "HEAD"]);
    plant(root, "rebase-merge/onto", `${honest}\n`);
    plant(root, "rebase-merge/rewritten-list", `${honest}\n`);
    plant(root, "sequencer/head", `${honest}\n`);
    for (const p of ["rebase-merge/onto", "rebase-merge/rewritten-list", "sequencer/head"]) {
      const r = await verifierGit(root, ["rev-parse", p]);
      expect(r.exitCode === 0 ? r.stdout.includes(honest) : r.exitCode === -1).toBe(true);
    }
  });

  it("control: sequencer/head/x (a dir under an exempt name) refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "sequencer/head/x", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "sequencer/head/x"]);
    expect(r.exitCode === -1).toBe(true);
  });
});

describe("CX-r28-B: anchored `add -A -- <dir>` silently drops session-ignored members", () => {
  it("a planted .gitignore shrinks the staged set while the channel reports success", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    // Session-authored ignore rule — never judged (CX-142 covers the
    // status-read side only).
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], { preflight: pre! });
    if (r.exitCode === -1 || r.exitCode !== 0) return; // refused/failed — honest
    const staged = git(root, ["ls-files"]);
    expect(staged.includes("d/secret.txt")).toBe(true);
  });

  it("control: an explicit ignored FILE pathspec fails honestly (exit != 0)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "secret.txt"], {
      preflight: pre!,
    });
    expect(r.exitCode === -1 || r.exitCode !== 0).toBe(true);
  });
});

describe("r28 coverage controls — honest-refusal assertions on neighboring surfaces", () => {
  it("modules/<name>/ nested oid plant refuses (populated-module refusal covers the dead-code path)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "modules/m1/x/FOO", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "modules/m1/x/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("worktrees/<id>/logs/FOO planted oid never served (embedded-gitdir check position)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["worktree", "add", "-q", "--detach", path.join(root, "wt2")]);
    const meta = path.join(root, ".git", "worktrees", "wt2");
    mkdirSync(path.join(meta, "logs"), { recursive: true });
    writeFileSync(path.join(meta, "logs", "FOO"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "worktrees/wt2/logs/FOO"]);
    // R36 metadir carve: a sibling metadir is foreign write surface the
    // overlay never serves — the consult is unresolvable (128) rather
    // than a judged refuse (-1); either way the planted oid is unserved.
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("lost-found/other/<non-oid-name> planted oid refuses; lost-found/other/<oid> is a payload-arbitrary residual", async () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "HEAD"]);
    plant(root, "lost-found/other/evil", `${honest}\n`);
    const r1 = await verifierGit(root, ["rev-parse", "lost-found/other/evil"]);
    expect(r1.exitCode === -1).toBe(true);
    plant(root, `lost-found/other/${honest}`, `${honest}\n`);
    const r2 = await verifierGit(root, ["rev-parse", `lost-found/other/${honest}`]);
    // Payload-arbitrary residual — may answer honestly or refuse, never
    // silently wrong (impossible here since content is the honest sha).
    expect(r2.exitCode === 0 || r2.exitCode === -1 || r2.exitCode === 128).toBe(true);
  });

  it("lost-found/commit/<oid> carrying ref: content refuses (symref at authored-oid position)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    const honest = git(root, ["rev-parse", "HEAD"]);
    plant(root, `lost-found/commit/${honest}`, "ref: refs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", `lost-found/commit/${honest}`]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("REF:/Ref:/rEf: spellings — git itself cannot parse them; the channel must never serve a sha", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    for (const [name, bytes] of [
      ["UC", `REF: refs/heads/evil\n`],
      ["MC", `Ref: refs/heads/evil\n`],
      ["RC", `rEf: refs/heads/evil\n`],
    ] as const) {
      plant(root, `x/${name}`, bytes);
      const r = await verifierGit(root, ["rev-parse", `x/${name}`]);
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    }
  });

  it("ref:+300-space ws-run at a check position refuses (r27-A fix holds)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "x/FOO", `ref:${" ".repeat(300)}refs/heads/evil\n`);
    const r = await verifierGit(root, ["rev-parse", "x/FOO"]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("a .git/logs/FOO fifo refuses PROMPTLY on gitEvidence (r27-C hazards fix holds)", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, ".git", "logs"), { recursive: true });
    mkfifo(path.join(root, ".git", "logs", "FOO"));
    const t0 = Date.now();
    const r = await gitEvidence(root, ["rev-parse", "logs/FOO"], { timeoutMs: 10_000 });
    const elapsed = Date.now() - t0;
    expect(r.exitCode).toBe(-1);
    expect(elapsed).toBeLessThan(15_000);
  });

  it("a fifo .pack next to a real .idx refuses promptly (verify-pack exits fast on non-regular packs)", async () => {
    const root = mkRepo();
    git(root, ["repack", "-ad", "-q"]);
    const packDir = path.join(root, ".git", "objects", "pack");
    const idx = execFileSync("ls", [packDir], { encoding: "utf8" })
      .split("\n")
      .find((n) => n.endsWith(".idx"))!;
    const packPath = path.join(packDir, idx.slice(0, -4) + ".pack");
    const real = packPath + ".real";
    execFileSync("mv", [packPath, real]);
    mkfifo(packPath);
    try {
      const t0 = Date.now();
      const r = await verifierGit(root, ["rev-parse", "HEAD"]);
      const elapsed = Date.now() - t0;
      expect(r.exitCode === -1 || r.stdout.length > 0).toBe(true);
      expect(elapsed).toBeLessThan(25_000);
    } finally {
      execFileSync("mv", ["-f", real, packPath]);
    }
  });

  it(
    "a mid-window rewrite of a symlinked-root-dir target inside an anchored reset refuses (r27-B pin fix holds)",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const foreign = foreignTip(root);
      const forgedBlob = git(root, ["rev-parse", `${foreign}:f.txt`]);
      const target = mkdtempSync(path.join(os.tmpdir(), "cx28-target-"));
      tmpdirs.push(target);
      const fooPath = path.join(target, "FOO");
      writeFileSync(fooPath, "junk\n");
      symlinkSync(target, path.join(root, ".git", "x"));
      // The watcher SIGSTOPs the reset child (argv carries x/FOO) and
      // rewrites the link target while frozen — the write lands inside
      // the armed window; the fp-leaf pin must catch it.
      const writer = startChildMutator(fooPath, `${foreign}\n`, "x/FOO");
      try {
        let forgedSeen = false;
        for (let attempt = 0; attempt < 50 && !forgedSeen; attempt++) {
          writeFileSync(fooPath, "junk\n");
          const pre = await evidenceRepoPreflight(root);
          expect(pre).not.toBeNull();
          const r = await evidenceAnchoredGit(root, ["reset", "-q", "x/FOO", "--", "f.txt"], {
            preflight: pre!,
          });
          if (r.exitCode === 0) {
            const staged = git(root, ["ls-files", "-s", "f.txt"]);
            if (staged.includes(forgedBlob)) forgedSeen = true;
          }
        }
        expect(forgedSeen).toBe(false);
      } finally {
        writer.stop();
      }
    },
  );

  it(
    "a mid-window objects/info/alternates plant inside an anchored reset refuses or lands post-op (then next-call refuses)",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      mkdirSync(path.join(root, ".git", "objects", "info"), { recursive: true });
      const altPath = path.join(root, ".git", "objects", "info", "alternates");
      // The create lands on a watched dir while the reset child is
      // frozen — refuse is required; if the watcher misses the window
      // the plant is a baseline violation the NEXT call must refuse.
      const writer = startChildMutator(altPath, `${root}\n`, "reset");
      try {
        const pre = await evidenceRepoPreflight(root);
        expect(pre).not.toBeNull();
        const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "f.txt"], {
          preflight: pre!,
        });
        expect(r.exitCode === 0 || r.exitCode === -1).toBe(true);
      } finally {
        writer.stop();
      }
      if (existsSync(altPath)) {
        const r2 = await verifierGit(root, ["rev-parse", "HEAD"]);
        expect(r2.exitCode).toBe(-1);
      }
    },
  );

  it(
    "a mid-window .git/shallow plant inside an anchored reset refuses or lands post-op (then next-call refuses)",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const shallow = path.join(root, ".git", "shallow");
      const writer = startChildMutator(shallow, `${git(root, ["rev-parse", "HEAD"])}\n`, "reset");
      try {
        const pre = await evidenceRepoPreflight(root);
        expect(pre).not.toBeNull();
        const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "f.txt"], {
          preflight: pre!,
        });
        expect(r.exitCode === 0 || r.exitCode === -1).toBe(true);
      } finally {
        writer.stop();
      }
      if (existsSync(shallow)) {
        const r2 = await verifierGit(root, ["rev-parse", "HEAD"]);
        expect(r2.exitCode).toBe(-1);
      }
    },
  );
});
