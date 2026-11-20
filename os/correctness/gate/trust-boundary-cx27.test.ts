/*
RFC-1616 round-27 independent adversarial probes — candidate commit
f1fb5c8b1, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.

Round-27 findings:

  CX-r27-A — `refContentShape` parser-parity hole on the `ref:` symref
    branch: the check judges only the FIRST ≤128-byte line, while git's
    loose-ref parser skips `isspace` (space, tab, \r, \n — empirically
    NOT \v/\f) across line boundaries and reads the refname wherever it
    lands. `ref:` followed by a whitespace run that CONTAINS a newline,
    or that pushes the refname past byte 128, parses in git but is
    invisible to the check: the first line is bare `ref:` + ws, so
    `/^ref:\s*\S/` misses. A planted `.git/<dir>/FOO` symref in any
    non-member position answers `rev-parse <dir>/FOO` with a forged rev
    — on every channel, including the anchored `reset`'s rev
    resolution.

    Fix: `refContentShape` returns a 3-way shape — `ref:` at byte 0 is
    `"symref"` UNCONDITIONALLY (git skips an arbitrary isspace run of
    any length up to its 256-byte read, and git never writes symref
    form into non-root names), and the oid branch mirrors
    `get_oid_hex`'s read-hashlen-from-byte-0 semantics (`<40hex>junk`
    parses — no trailing-byte requirement). The consult judge
    classifies leaf positions three ways — `root` (baseline residual:
    gitdir root, member namespaces, embedded-gitdir roots,
    payload-arbitrary `lost-found/other/<oid>`), `oid` (names git
    writes bare-oid rev content into: `logs/HEAD`, `logs/refs/**`,
    `lost-found/commit/<oid>`, the state-file set), `check` (anything
    else) — and symref form is a violation at EVERY non-root position,
    authored names included (CX-r27-A report note: refusing symref
    shape at exempt names tightens at zero false-refuse cost).

  CX-r27-B — `.git/<link> -> <dir>` root-level symlinked dirs ARE
    fingerprinted through `nestedFiles` (the capture sweep follows the
    link, so `<link>/<name>` content is judged and reproved), but the
    SPAWN-WINDOW machinery never followed them: `collectTreeDirs` only
    pushed real dirent dirs (unwatched target), and `pinTree`'s
    `enumerateTreeFiles` recorded the link as ONE leaf pinning only the
    target DIR's stat — never the files inside. An in-place content
    rewrite of a file inside the TARGET tree fired no inotify event and
    bumped no pinned stat — a dirent-invisible write that survived the
    arm-to-settle window. Read channels were saved by the post-drain
    fingerprint reprove; `evidenceAnchoredGit` skips it
    (`opts?.anchored === undefined` gate) — a mid-mutation rewrite of
    `<target>/FOO` to `<sha>` steered `reset -q x/FOO -- <paths>`'s rev
    resolution into a forged blob claim. CONFIRMED LIVE.

    Fix: `collectTreeDirs` descends through symlinks that resolve to
    dirs, so `fs.watch` arms the link path (inotify follows to the
    target inode — in-target writes fire events under the link path);
    and the pin layer pins the fingerprint's own leaf maps
    (`rootFiles` + `nestedFiles` + member trees) instead of a fresh
    re-enumeration — pin coverage ≡ judged coverage, so link-path-keyed
    target members are pinned like everything else. A link cycle
    exhausts the dir bound → unarmable → refuse.

  CX-r27-C — `evidencePreflight` (os/flow/git.ts) collected `hazards`
    from `captureEvidenceSurface` but never consulted it — a nested
    `.git/logs/FOO` fifo stalled `gitEvidence`'s spawned child on
    open() to the spawn timeout instead of refusing promptly.

    Fix: `hazards` feeds `configUnproven` and skips claims
    enumeration, mirroring `evidenceRepoPreflight` — non-regular
    consultable metadata refuses before any judged spawn.

Attacker primitive for CX-r27-B: a /proc watcher polls
`/proc/<pid>/task/<tid>/children`; on each new child it SIGSTOPs it
(same-UID), reads `/proc/<pid>/cmdline` — re-reading across the
fork→exec window until the real argv shows `git … x/FOO` — then
rewrites the target file while the child is frozen and SIGCONTs. The
write lands deterministically inside the armed window, after the
pre-spawn reprove already passed.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
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
  const root = mkdtempSync(path.join(os.tmpdir(), "cx27-"));
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
const plant = (root: string, rel: string, content: string) =>
  writeFileSync(path.join(root, ".git", rel), content);

const mkfifo = (p: string) => execFileSync("mkfifo", [p]);

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/**
 * Session-resident fifo feeder: reader fd keeps the pipe alive; writer
 * pulses deliver `payload` then EOF so the judged child's read-to-EOF
 * completes with attacker bytes on every open window.
 */
const startFifoFeeder = (fifo: string, payload: string, secs = 120, hex = false) => {
  const child = spawn(
    "python3",
    [
      "-c",
      "import os,sys,time\n" +
        "fifo=sys.argv[1]; data=(bytes.fromhex(sys.argv[2]) if sys.argv[4]=='hex' else sys.argv[2].encode()); end=time.time()+float(sys.argv[3])\n" +
        "rfd=os.open(fifo,os.O_RDONLY|os.O_NONBLOCK)\n" +
        "while time.time()<end:\n" +
        "    try:\n" +
        "        wfd=os.open(fifo,os.O_WRONLY|os.O_NONBLOCK)\n" +
        "        os.write(wfd,data)\n" +
        "        time.sleep(0.004)\n" +
        "        os.close(wfd)\n" +
        "        time.sleep(0.002)\n" +
        "    except OSError:\n" +
        "        time.sleep(0.001)\n",
      fifo,
      payload,
      String(secs),
      hex ? "hex" : "text",
    ],
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

/**
 * /proc-children watcher (CX-r27-B): a persistent bash poller — the
 * instant ANY git child of this process exists (the judged spawn, after
 * the reprove already passed) write `payload` to `target`. Builtins
 * only (`$(<file)`, `read`, `printf` redirect) — a new child is seen
 * within ~0.5 ms of its spawn, inside the ~2–5 ms window before git's
 * own `open()` of the consulted file. Writes once per detected child so
 * every internal probe spawn is covered too.
 */
const startChildWriter = (target: string, payload: string, match: string, secs = 300) => {
  // Same-UID primitive: poll /proc children; the instant a child whose
  // argv matches `match` appears, SIGSTOP it (it is frozen wherever it
  // is — almost always before its own open()/read() of the target),
  // rewrite the target content while frozen, then SIGCONT. The write
  // lands deterministically inside the judged child's lifetime — the
  // reprove passed before spawn, the settle pins only the target DIR's
  // stat, and /tmp is in no watcher's scope.
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
    "        # STOP on sight — between fork and exec the child still shows\n" +
    "        # the parent's cmdline; hold it, read, CONT, and keep polling\n" +
    "        # until its post-exec argv is visible (bounded retries).\n" +
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
    "            # Exec'd to a non-matching image — never a match; let it go.\n" +
    "            seen.add(k)\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: pass\n" +
    "        else:\n" +
    "            # Pre-exec node image or empty cmdline — release and\n" +
    "            # re-check on a bounded retry budget.\n" +
    "            n=retries.get(k,0)+1; retries[k]=n\n" +
    "            if n>200: seen.add(k)\n" +
    "            try: os.kill(int(k),18)\n" +
    "            except: seen.add(k)\n";
  const child = spawn(
    "python3",
    ["-c", script, target, payload, String(process.pid), match, String(secs)],
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

describe("CX-r27-A: ref:-symref whitespace-run escapes refContentShape (parser parity)", () => {
  // Sanity: ambient git itself resolves these file shapes — proven so a
  // skipped verifier is distinguishable from an unresolvable file.
  it("sanity: ambient git resolves ref:\\n<refname>, ref:+long-ws-run, ref:+mixed-ws", () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "refs/heads/main"]);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    plant(root, "x/FOO", "ref:\nrefs/heads/main\n");
    expect(git(root, ["rev-parse", "x/FOO"])).toBe(honest);
    plant(root, "x/BAR", `ref:${" ".repeat(300)}refs/heads/main\n`);
    expect(git(root, ["rev-parse", "x/BAR"])).toBe(honest);
    plant(root, "x/BAZ", "ref:\t\n \nrefs/heads/main\n");
    expect(git(root, ["rev-parse", "x/BAZ"])).toBe(honest);
    plant(root, "x/CRLF", "ref:\r\nrefs/heads/main\n");
    expect(git(root, ["rev-parse", "x/CRLF"])).toBe(honest);
  });

  it("a .git/logs/FOO symref (refname on line 2) answers verifierGit rev-parse forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "logs/FOO", "ref:\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "logs/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/x/FOO symref (refname past the 128-byte prefix) answers gitEvidence forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    plant(root, "x/FOO", `ref:${" ".repeat(300)}refs/heads/evil\n`);
    const r = await gitEvidence(root, ["rev-parse", "x/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/info/FOO symref (tab+nl ws-run) answers verifierScratchGit forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "info/FOO", "ref:\t\n \nrefs/heads/evil\n");
    const r = await verifierScratchGit(root, ["rev-parse", "info/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/hooks/FOO symref (crlf ws-run) answers verifierGit forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "hooks/FOO", "ref:\r\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "hooks/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/forge/FOO symref answers gitEvidence forged (forge/ is judged like any nested dir)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "forge"), { recursive: true });
    plant(root, "forge/FOO", "ref:\n\n\nrefs/heads/evil\n");
    const r = await gitEvidence(root, ["rev-parse", "forge/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/rebase-merge/FOO symref answers verifierGit forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "rebase-merge"), { recursive: true });
    plant(root, "rebase-merge/FOO", "ref:\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "rebase-merge/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/sequencer/FOO symref (non-exempt name) answers verifierGit forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "sequencer"), { recursive: true });
    plant(root, "sequencer/FOO", "ref:\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "sequencer/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/rr-cache/x/FOO symref answers gitEvidence forged (deep novel dir)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "rr-cache", "x"), { recursive: true });
    plant(root, "rr-cache/x/FOO", "ref:\nrefs/heads/evil\n");
    const r = await gitEvidence(root, ["rev-parse", "rr-cache/x/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/x/deep/FOO symref answers verifierGit forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "x", "deep"), { recursive: true });
    plant(root, "x/deep/FOO", "ref:\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "x/deep/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/logs/deep/FOO symref answers verifierGit forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "logs", "deep"), { recursive: true });
    plant(root, "logs/deep/FOO", "ref:\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "logs/deep/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a symlinked root dir carrying the symref: .git/x -> dir, target FOO = ref:\\n... forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    const target = mkdtempSync(path.join(os.tmpdir(), "cx27-target-"));
    tmpdirs.push(target);
    writeFileSync(path.join(target, "FOO"), "ref:\nrefs/heads/evil\n");
    symlinkSync(target, path.join(root, ".git", "x"));
    // `x/FOO` is a nested consult position — the miss means baseline and
    // git resolves through the link.
    const r = await verifierGit(root, ["rev-parse", "x/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a symref pair steers merge-base --is-ancestor — verifierGit answers forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root); // child of HEAD → HEAD IS its ancestor
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, ["branch", "anc", head]);
    git(root, ["branch", "desc", foreign]);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    // `x/anc` -> foreign, `x/desc` -> head: swap-resolves (foreign, head)
    // → answers 1 (not-ancestor); the honest 0 flips.
    plant(root, "x/anc", "ref:\nrefs/heads/desc\n");
    plant(root, "x/desc", "ref:\nrefs/heads/anc\n");
    const r = await verifierGit(root, ["merge-base", "--is-ancestor", "x/anc", "x/desc"]);
    expect(r.exitCode === -1 || r.exitCode === 0).toBe(true);
  });

  it("a .git/logs/FOO symref fabricates log history — gitEvidence log -1 serves the foreign tip", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "logs/FOO", "ref:\nrefs/heads/evil\n");
    const r = await gitEvidence(root, ["log", "-1", "--format=%H", "logs/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("a .git/logs/FOO symref serves cat-file forged commit bytes", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "logs/FOO", "ref:\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["cat-file", "commit", "logs/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes("evil")).toBe(true);
  });

  it("a .git/x/FOO symref steers the anchored reset — foreign blob staged", async () => {
    const root = mkRepo();
    const honestBlob = git(root, ["rev-parse", "HEAD:f.txt"]);
    const foreign = foreignTip(root);
    const forgedBlob = git(root, ["rev-parse", `${foreign}:f.txt`]);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    plant(root, "x/FOO", "ref:\nrefs/heads/evil\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "x/FOO", "--", "f.txt"], {
      preflight: pre!,
    });
    if (r.exitCode === -1 || r.exitCode !== 0) return;
    const staged = git(root, ["ls-files", "-s", "f.txt"]);
    expect(staged.includes(forgedBlob) === false && staged.includes(honestBlob)).toBe(true);
  });

  it("a .git/logs/FOO symref answers the origin channel forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "logs/FOO", "ref:\nrefs/heads/evil\n");
    const origin = createOriginGit(root);
    const r = await origin.run(["rev-parse", "logs/FOO"]);
    // null = degraded (honest); the foreign sha is a live hole.
    expect(r === null || r.trim() !== foreign).toBe(true);
  });

  it("a .git/logs/FOO symref answers the origin batch channel forged (showMany)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "logs/FOO", "ref:\nrefs/heads/evil\n");
    const origin = createOriginGit(root);
    const r = await origin.showMany?.(["logs/FOO:f.txt"]);
    // null/undefined = degraded; FORGED bytes are a live hole.
    expect(r == null || r[0] !== "FORGED\n").toBe(true);
  });

  it("a worktrees/<id>/logs/FOO symref inside a real metadir answers verifierGit forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    git(root, ["worktree", "add", "-q", "--detach", path.join(root, "wt2")]);
    const meta = path.join(root, ".git", "worktrees", "wt2");
    mkdirSync(path.join(meta, "logs"), { recursive: true });
    writeFileSync(path.join(meta, "logs", "FOO"), "ref:\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "worktrees/wt2/logs/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("boundary: refname lands at byte 128 — 124 spaces misses, 123 flags", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    // `ref:` + 124 spaces = 128 bytes — refname sits just past the
    // prefix window: missed → resolves (hole).
    plant(root, "x/PAST", `ref:${" ".repeat(124)}refs/heads/evil\n`);
    const past = await verifierGit(root, ["rev-parse", "x/PAST"]);
    expect(past.exitCode === -1 || !past.stdout.includes(foreign)).toBe(true);
    // `ref:` + 123 spaces = 127 bytes + 'r' of the refname in-window:
    // `\S` matches → violation → refused (control).
    plant(root, "x/EDGE", `ref:${" ".repeat(123)}refs/heads/evil\n`);
    const edge = await verifierGit(root, ["rev-parse", "x/EDGE"]);
    expect(edge.exitCode === -1).toBe(true);
  });

  it("a fabricated x/MERGE_HEAD via ref:\\n... reports merge-in-progress forged", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    plant(root, "x/MERGE_HEAD", "ref:\nrefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "--verify", "-q", "x/MERGE_HEAD"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  // Controls — shapes that DO get flagged must refuse; shapes git
  // cannot parse must never produce a sha.
  it("control: same-line `ref: refs/heads/evil` refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "logs/FOO", "ref: refs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "logs/FOO"]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("control: `ref:refs/heads/evil` (no space) refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    plant(root, "logs/FOO", "ref:refs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "logs/FOO"]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("control: a bare <sha> in the same position refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "logs/FOO", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "logs/FOO"]);
    expect(r.exitCode === -1).toBe(true);
  });

  it("control: `ref:` + dead target answers honestly (dangling symref)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    plant(root, "logs/FOO", "ref:\nrefs/heads/nonexistent\n");
    const r = await verifierGit(root, ["rev-parse", "logs/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("control: `ref:` + \\v ws-run — git cannot parse it either (consistent)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    plant(root, "x/FOO", "ref:\x0brefs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "x/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("control: leading-newline `\\nref: refs/heads/evil` — git cannot parse (not ref-prefixed)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    plant(root, "x/FOO", "\nref: refs/heads/evil\n");
    const r = await verifierGit(root, ["rev-parse", "x/FOO"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });
});

describe("CX-r27-B: symlinked root dir target-tree invisibility on the anchored channel", () => {
  it("a .git/x -> dir link is fingerprinted — ref-parseable target content refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    const target = mkdtempSync(path.join(os.tmpdir(), "cx27-target-"));
    tmpdirs.push(target);
    writeFileSync(path.join(target, "FOO"), `${foreign}\n`);
    symlinkSync(target, path.join(root, ".git", "x"));
    // `x/FOO` is a nested consult position — sha content is judged
    // THROUGH the link and refuses.
    const r = await verifierGit(root, ["rev-parse", "x/FOO"]);
    expect(r.exitCode).toBe(-1);
  });

  it(
    "in-place rewrite of a symlinked-root-dir target file inside the anchored window steers `reset`'s rev resolution — foreign blob staged",
    { timeout: 180_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const honestBlob = git(root, ["rev-parse", "HEAD:f.txt"]);
      const foreign = foreignTip(root);
      const forgedBlob = git(root, ["rev-parse", `${foreign}:f.txt`]);
      const target = mkdtempSync(path.join(os.tmpdir(), "cx27-target-"));
      tmpdirs.push(target);
      const fooPath = path.join(target, "FOO");
      // Non-parseable baseline so the consult check passes.
      writeFileSync(fooPath, "junk\n");
      symlinkSync(target, path.join(root, ".git", "x"));
      let forgedSeen = false;
      // ONE persistent watcher for the whole loop — SIGSTOPs the
      // mutation child on sight (argv carries `x/FOO`), rewrites the
      // target while frozen, CONTs: the write lands deterministically
      // inside the armed window. A FRESH preflight each attempt —
      // rewriting junk between attempts bumps ctime, which only a
      // fresh fingerprint proves as baseline.
      const writer = startChildWriter(fooPath, `${foreign}\n`, "x/FOO");
      try {
        for (let attempt = 0; attempt < 200 && !forgedSeen; attempt++) {
          writeFileSync(fooPath, "junk\n"); // honest baseline for the fresh preflight
          const pre = await evidenceRepoPreflight(root);
          expect(pre).not.toBeNull();
          const r = await evidenceAnchoredGit(root, ["reset", "-q", "x/FOO", "--", "f.txt"], {
            preflight: pre!,
          });
          if (r.exitCode === 0) {
            const staged = git(root, ["ls-files", "-s", "f.txt"]);
            if (staged.includes(forgedBlob) && !staged.includes(honestBlob)) forgedSeen = true;
          }
        }
      } finally {
        writer.stop();
      }
      // The target write lands in no watcher's scope and anchored ops
      // skip the post-drain reprove — a staged foreign blob means the
      // hole is live.
      expect(forgedSeen).toBe(false);
    },
  );

  it(
    "control: the same in-window target rewrite on verifierGit refuses (post-drain reprove covers reads)",
    { timeout: 180_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      const root = mkRepo();
      const foreign = foreignTip(root);
      const target = mkdtempSync(path.join(os.tmpdir(), "cx27-target-"));
      tmpdirs.push(target);
      const fooPath = path.join(target, "FOO");
      writeFileSync(fooPath, "junk\n");
      symlinkSync(target, path.join(root, ".git", "x"));
      let sawForged = false;
      const writer = startChildWriter(fooPath, `${foreign}\n`, "x/FOO");
      try {
        for (let attempt = 0; attempt < 100 && !sawForged; attempt++) {
          writeFileSync(fooPath, "junk\n");
          const r = await verifierGit(root, ["rev-parse", "x/FOO"]);
          if (r.exitCode !== -1 && r.stdout.includes(foreign)) sawForged = true;
        }
      } finally {
        writer.stop();
      }
      expect(sawForged).toBe(false);
    },
  );
});

describe("CX-r27-C: gitEvidence drops hazards — nested non-regular nodes stall to the spawn timeout", () => {
  // `evidencePreflight` (os/flow/git.ts) collects `hazards` in
  // captureEvidenceSurface's return but never consults it — the
  // `unverifiableNodes` list (kind-flagged member/nested fifos) is
  // silently dropped on this channel, and `gitEvidence` never runs
  // `discoverGitMetaHazards` pre-spawn. `verifierGit`'s
  // `evidenceRepoPreflight` gates hazards → refuse; the flow channel
  // proceeds to a clean judgment and spawns.
  //
  // A session feeder CANNOT actually forge here: every fifo write
  // bumps the inode ctime, and the armed window's pin on the fifo
  // turns the feeder's own write into drift → refuse (self-denying).
  // What IS live: a readerless fifo stalls the spawned child on
  // open() until the spawn timeout — a hang, never a prompt refusal.
  it("a .git/logs/FOO fifo + session feeder answers gitEvidence rev-parse forged", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "logs"), { recursive: true });
    mkfifo(path.join(root, ".git", "logs", "FOO"));
    const feeder = startFifoFeeder(path.join(root, ".git", "logs", "FOO"), `${foreign}\n`);
    try {
      const r = await gitEvidence(root, ["rev-parse", "logs/FOO"], { timeoutMs: 10_000 });
      // Contract: refuse (-1) or fail honestly — the foreign sha is a
      // live hole.
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    } finally {
      feeder.stop();
    }
  });

  it("a .git/info/FOO fifo + session feeder answers gitEvidence forged", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    mkfifo(path.join(root, ".git", "info", "FOO"));
    const feeder = startFifoFeeder(path.join(root, ".git", "info", "FOO"), `${foreign}\n`);
    try {
      const r = await gitEvidence(root, ["rev-parse", "info/FOO"], { timeoutMs: 10_000 });
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    } finally {
      feeder.stop();
    }
  });

  it("a .git/x/FOO fifo + session feeder answers gitEvidence forged", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "x"), { recursive: true });
    mkfifo(path.join(root, ".git", "x", "FOO"));
    const feeder = startFifoFeeder(path.join(root, ".git", "x", "FOO"), `${foreign}\n`);
    try {
      const r = await gitEvidence(root, ["rev-parse", "x/FOO"], { timeoutMs: 10_000 });
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    } finally {
      feeder.stop();
    }
  });

  it("a .git/forge/FOO fifo + session feeder answers gitEvidence forged", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "forge"), { recursive: true });
    mkfifo(path.join(root, ".git", "forge", "FOO"));
    const feeder = startFifoFeeder(path.join(root, ".git", "forge", "FOO"), `${foreign}\n`);
    try {
      const r = await gitEvidence(root, ["rev-parse", "forge/FOO"], { timeoutMs: 10_000 });
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    } finally {
      feeder.stop();
    }
  });

  it("a .git/worktrees/<id>/FOO fifo + session feeder answers gitEvidence forged", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["worktree", "add", "-q", "--detach", path.join(root, "wt2")]);
    mkfifo(path.join(root, ".git", "worktrees", "wt2", "FOO"));
    const feeder = startFifoFeeder(
      path.join(root, ".git", "worktrees", "wt2", "FOO"),
      `${foreign}\n`,
    );
    try {
      const r = await gitEvidence(root, ["rev-parse", "worktrees/wt2/FOO"], {
        timeoutMs: 10_000,
      });
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    } finally {
      feeder.stop();
    }
  });

  it("a loose-object-path fifo in the objects fanout + zlib feeder answers gitEvidence cat-file forged bytes", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const head = git(root, ["rev-parse", "HEAD"]);
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
    // A plausible-but-absent object name — git opens objects/ab/<38>.
    const name = `ab${"0".repeat(38)}`;
    const content = `tree ${tree}\nparent ${head}\nauthor T <t@t> 0 +0000\ncommitter T <t@t> 0 +0000\n\nFORGED\n`;
    const payload = deflateSync(Buffer.from(`commit ${content.length}\0${content}`)).toString(
      "hex",
    );
    mkdirSync(path.join(root, ".git", "objects", "ab"), { recursive: true });
    mkfifo(path.join(root, ".git", "objects", "ab", "0".repeat(38)));
    const feeder = startFifoFeeder(
      path.join(root, ".git", "objects", "ab", "0".repeat(38)),
      payload,
      120,
      true,
    );
    try {
      const r = await gitEvidence(root, ["cat-file", "commit", name], { timeoutMs: 10_000 });
      // Honest answer: the object does not exist (exit nonzero). Served
      // FORGED bytes are a live hole.
      expect(r.exitCode === -1 || !r.stdout.includes("FORGED")).toBe(true);
    } finally {
      feeder.stop();
    }
  });

  it("a nested fifo with no feeder STALLS gitEvidence to the spawn timeout (never refuses)", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    mkdirSync(path.join(root, ".git", "logs"), { recursive: true });
    mkfifo(path.join(root, ".git", "logs", "FOO"));
    const t0 = Date.now();
    const r = await gitEvidence(root, ["rev-parse", "logs/FOO"], { timeoutMs: 5_000 });
    const elapsed = Date.now() - t0;
    // Contract: refuse BEFORE spawning. The observed shape is a child
    // blocked on fifo open() killed at the timeout — a stall is neither
    // a truthful answer nor a prompt refusal.
    expect(r.exitCode === -1 && elapsed < 3_000).toBe(true);
  });
});

describe("honest-refusal checks: residuals, name positions, kind coverage, forge churn", () => {
  it("residual: .git/FOO regular-file pseudo-ref answers its attested bytes", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    writeFileSync(path.join(root, ".git", "FOO"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "FOO"]);
    // Accepted residual — attested baseline answers honestly.
    expect(r.exitCode === -1 || r.stdout.trim() === foreign || r.exitCode !== 0).toBe(true);
  });

  it("residual: logs/refs/<name> authored-name position answers attested bytes", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "logs", "refs", "heads"), { recursive: true });
    plant(root, "logs/refs/heads/evil", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "logs/refs/heads/evil"]);
    expect(r.exitCode === -1 || r.stdout.trim() === foreign || r.exitCode !== 0).toBe(true);
  });

  it("residual: lost-found/commit/<oid> answers its content sha", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    const name = "a".repeat(40);
    mkdirSync(path.join(root, ".git", "lost-found", "commit"), { recursive: true });
    plant(root, `lost-found/commit/${name}`, `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", `lost-found/commit/${name}`]);
    expect(r.exitCode === -1 || r.stdout.trim() === foreign || r.exitCode !== 0).toBe(true);
  });

  it("residual: sequencer/head authored-name position", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "sequencer"), { recursive: true });
    plant(root, "sequencer/head", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "sequencer/head"]);
    expect(r.exitCode === -1 || r.stdout.trim() === foreign || r.exitCode !== 0).toBe(true);
  });

  it("residual: worktrees/<id> metadir root file answers attested bytes", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["worktree", "add", "-q", "--detach", path.join(root, "wt2")]);
    writeFileSync(path.join(root, ".git", "worktrees", "wt2", "FOO"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "worktrees/wt2/FOO"]);
    expect(r.exitCode === -1 || r.stdout.trim() === foreign || r.exitCode !== 0).toBe(true);
  });

  it("a fifo under logs/ refuses promptly on verifierGit and verifierScratchGit", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, ".git", "logs"), { recursive: true });
    mkfifo(path.join(root, ".git", "logs", "FOO"));
    for (const ch of [
      () => verifierGit(root, ["rev-parse", "logs/FOO"]),
      () => verifierScratchGit(root, ["rev-parse", "logs/FOO"]),
    ]) {
      const t0 = Date.now();
      const r = await ch();
      expect(r.exitCode).toBe(-1);
      expect(Date.now() - t0).toBeLessThan(5000);
    }
  });

  it("a fifo deep in the objects fanout refuses", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, ".git", "objects", "ab"), { recursive: true });
    mkfifo(path.join(root, ".git", "objects", "ab", "c".repeat(38)));
    const r = await verifierGit(root, ["rev-parse", "HEAD"]);
    expect(r.exitCode).toBe(-1);
  });

  it("a fifo inside worktrees/<id> refuses", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, ".git", "worktrees", "wt1"), { recursive: true });
    mkfifo(path.join(root, ".git", "worktrees", "wt1", "FOO"));
    const r = await verifierGit(root, ["rev-parse", "HEAD"]);
    expect(r.exitCode).toBe(-1);
  });

  it("a symlink -> regular sha file under info/ is judged through and refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    const target = path.join(os.tmpdir(), `cx27-sha-${process.pid}`);
    writeFileSync(target, `${foreign}\n`);
    mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    symlinkSync(target, path.join(root, ".git", "info", "X"));
    const r = await verifierGit(root, ["rev-parse", "info/X"]);
    expect(r.exitCode).toBe(-1);
    rmSync(target, { force: true });
  });

  it("a symlink -> fifo under logs/ refuses", async () => {
    const root = mkRepo();
    const fifo = path.join(os.tmpdir(), `cx27-fifo-${process.pid}`);
    mkfifo(fifo);
    symlinkSync(fifo, path.join(root, ".git", "logs", "X"));
    const r = await verifierGit(root, ["rev-parse", "logs/X"]);
    expect(r.exitCode).toBe(-1);
    rmSync(fifo, { force: true });
  });

  it("a dangling symlink under logs/ whose fifo target appears post-preflight is drift", async () => {
    const root = mkRepo();
    const fifo = path.join(os.tmpdir(), `cx27-fifo-${process.pid}`);
    symlinkSync(fifo, path.join(root, ".git", "logs", "X"));
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    mkfifo(fifo);
    const r = await verifierGit(root, ["rev-parse", "logs/X"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
    rmSync(fifo, { force: true });
  });

  it("a member dir delete+recreate between preflight and read is drift", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    rmSync(path.join(root, ".git", "refs"), { recursive: true, force: true });
    mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
    const r = await verifierGit(root, ["rev-parse", "HEAD"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
  });

  it("objects-evil/FOO novel dir: coveredByMember prefix confusion stays a consult position", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "objects-evil"), { recursive: true });
    plant(root, "objects-evil/FOO", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "objects-evil/FOO"]);
    expect(r.exitCode).toBe(-1);
  });

  it("a populated modules/ tree refuses the whole channel", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "modules", "x"), { recursive: true });
    plant(root, "modules/x/FOO", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "modules/x/FOO"]);
    expect(r.exitCode).toBe(-1);
  });

  it("a forge/ file with ref-parseable content refuses (planted pseudo-ref)", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "forge"), { recursive: true });
    plant(root, "forge/FOO", `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "forge/FOO"]);
    expect(r.exitCode).toBe(-1);
  });

  it("sustained .git/forge churn during a read answers refused-or-honest, never forged", async () => {
    const root = mkRepo();
    const honest = git(root, ["rev-parse", "HEAD"]);
    mkdirSync(path.join(root, ".git", "forge"), { recursive: true });
    let stop = false;
    const churn = setInterval(() => {
      if (stop) return;
      try {
        writeFileSync(path.join(root, ".git", "forge", "j"), `${Date.now()}\n`);
      } catch {
        /* dir gone */
      }
    }, 5);
    try {
      const r = await verifierGit(root, ["rev-parse", "HEAD"]);
      expect(r.exitCode === -1 || r.stdout.trim() === honest).toBe(true);
    } finally {
      stop = true;
      clearInterval(churn);
    }
  });

  it("a forge write between anchored preflight and mutation refuses (honest flux, no forgery)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "g.txt"), "new\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    mkdirSync(path.join(root, ".git", "forge"), { recursive: true });
    writeFileSync(path.join(root, ".git", "forge", "journal"), "{}\n");
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "g.txt"], { preflight: pre! });
    // The drifted anchored surface must refuse — `add` has no ride-out.
    expect(r.exitCode).toBe(-1);
  });

  it("sequencer real-state files do not false-refuse a quiet repo", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    git(root, ["update-ref", "refs/heads/evil", foreign]);
    mkdirSync(path.join(root, ".git", "sequencer"), { recursive: true });
    // Real git-authored shapes: exempt sha files + a non-parseable todo.
    const head = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, ".git", "sequencer", "head"), `${head}\n`);
    writeFileSync(path.join(root, ".git", "sequencer", "abort-safety"), `${head}\n`);
    writeFileSync(path.join(root, ".git", "sequencer", "todo"), `pick ${head.slice(0, 7)} c2\n`);
    const r = await verifierGit(root, ["rev-parse", "HEAD"]);
    expect(r.exitCode === 0 && r.stdout.trim() === head).toBe(true);
  });

  it("a real conflicted cherry-pick leaves a quiet honest surface", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "v2\n");
    git(root, ["commit", "-qam", "c2"]);
    writeFileSync(path.join(root, "f.txt"), "v3\n");
    git(root, ["commit", "-qam", "c3"]);
    git(root, ["checkout", "-qb", "other", "HEAD~2"]);
    writeFileSync(path.join(root, "f.txt"), "vx\n");
    git(root, ["commit", "-qam", "cx"]);
    // A two-commit pick that conflicts on the first → real sequencer
    // state (head/abort-safety/todo) plus MERGE_MSG + conflicted index.
    spawnSync("git", ["-C", root, "cherry-pick", "main~1", "main"], { encoding: "utf8" });
    const r = await verifierGit(root, ["rev-parse", "HEAD"]);
    expect(r.exitCode === -1 || /^[0-9a-f]{40}$/.test(r.stdout.trim())).toBe(true);
  });
});
