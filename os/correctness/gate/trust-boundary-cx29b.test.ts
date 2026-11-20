/*
RFC-1616 round-29 independent adversarial probes — candidate commit
27daa3805, exported tree.

CX-r29-B — `verifyAnchoredAddCoverage` attests a `.gitignore` source
with a claims-index `status` run AFTER the `check-ignore` consult, but
the worktree `.gitignore` file is OUTSIDE the armed `.git` watch —
a same-UID session flips its bytes mid-window:

  1. `.gitignore` worktree bytes carry `d/secret.txt` (foreign rule —
     claims index holds the committed `# none` bytes).
  2. The anchored `add -A -- d` consults the dirty bytes → silently
     drops `d/secret.txt` (CX-r28-B shrink).
  3. `check-ignore -v` still reads the dirty bytes → cites source
     `.gitignore` for the residual.
  4. The session restores `.gitignore` to the committed bytes BEFORE
     the claims-index `status` runs → status reports clean → source
     "attested" → coverage returns null → exit 0 escapes with a member
     dropped by bytes that were NEVER attested.

The design bound is outcome-equivalence: a flip+restore "that leaves
matching state" is honest residual — but that bound requires the
CONSULTED bytes to be the attested bytes. Here the consulted bytes
(foreign rule) and the attested bytes (committed blob) diverge inside
one window — the claims-status only samples the end state.

Fix: `enumerateTrackedRuleSources` lists every tracked `*.gitignore`
from the pre-op claims index BEFORE the watch arms, and the paths
join `anchoredExtraWatch` — each source inode carries an
ino+ctimeMs stat pin plus a dirent watch from before the op's own
consult. A mid-window flip+restore bumps ctime (unrestorable) so the
settle drain refuses; a flip landing before the arm leaves
worktree≠claims bytes the clean-source check refuses.
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

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx29b-"));
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
 * /proc-children mutator (cx28 primitive): the instant a git child of
 * this process whose argv contains `match` appears, SIGSTOP it, write
 * `data` at `tgt`, SIGCONT. The write lands inside the judged child's
 * lifetime — deterministic mid-window state for ITS read.
 */
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

/**
 * A fast flipper: alternate `.gitignore` between committed-clean and
 * foreign-rule bytes at sub-millisecond cadence — the claims-status
 * sample lands on clean ~half the time while add/check-ignore land on
 * dirty ~half — ~12.5% forge odds per call.
 */
const startFlipper = (tgt: string, clean: string, dirty: string) => {
  const script =
    "import sys,time\n" +
    "tgt,clean,dirty,end=sys.argv[1],sys.argv[2].encode(),sys.argv[3].encode(),time.time()+float(sys.argv[4])\n" +
    "while time.time()<end:\n" +
    "    open(tgt,'wb').write(dirty)\n" +
    "    open(tgt,'wb').write(clean)\n";
  const child = spawn("python3", ["-c", script, tgt, clean, dirty, "120"], { stdio: "ignore" });
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

describe("CX-r29-B: mid-window .gitignore flip defeats source attestation", () => {
  it(
    "deterministic: restore `.gitignore` exactly when the claims-status child spawns — dirty@add+check-ignore, clean@status",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 25 && forged === 0; attempt++) {
        const root = mkRepo();
        // Committed decoy content — the claims index holds these bytes.
        writeFileSync(path.join(root, ".gitignore"), "# none\n");
        git(root, ["add", ".gitignore"]);
        git(root, ["commit", "-qm", "ign"]);
        mkdirSync(path.join(root, "d"), { recursive: true });
        writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
        writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
        // Foreign rule is LIVE in the worktree before the op — add and
        // check-ignore consult it; only the claims-status must see clean.
        writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
        const pre = await evidenceRepoPreflight(root);
        expect(pre).not.toBeNull();
        const giPath = path.join(root, ".gitignore");
        // The claims-status argv carries `--untracked-files=all` —
        // unique among the op's children; freeze it, restore clean.
        const writer = startChildMutator(giPath, "# none\n", "--untracked-files=all");
        try {
          const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], {
            preflight: pre!,
          });
          if (r.exitCode === -1) refused++;
          else {
            const staged = git(root, ["ls-files", "--", "d"]);
            if (staged.includes("d/secret.txt")) honest++;
            else forged++;
          }
        } finally {
          writer.stop();
          writeFileSync(path.join(root, ".gitignore"), "# none\n");
        }
      }
      console.log(`flip-on-status: forged=${forged} refused=${refused} honest=${honest}`);
      expect(forged).toBe(0);
    },
  );

  it(
    "statistical: a dumb flipper still lands dirty@add+check-ignore / clean@status forges",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      const root = mkRepo();
      writeFileSync(path.join(root, ".gitignore"), "# none\n");
      git(root, ["add", ".gitignore"]);
      git(root, ["commit", "-qm", "ign"]);
      mkdirSync(path.join(root, "d"), { recursive: true });
      writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
      writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
      const giPath = path.join(root, ".gitignore");
      const flip = startFlipper(giPath, "# none\n", "d/secret.txt\n");
      try {
        for (let attempt = 0; attempt < 40 && forged === 0; attempt++) {
          const pre = await evidenceRepoPreflight(root);
          if (pre === null) continue;
          const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], {
            preflight: pre,
          });
          if (r.exitCode === -1) refused++;
          else {
            const staged = git(root, ["ls-files", "--", "d"]);
            if (staged.includes("d/secret.txt")) honest++;
            else forged++;
          }
          git(root, ["reset", "-q"]);
        }
      } finally {
        flip.stop();
        writeFileSync(giPath, "# none\n");
      }
      console.log(`flipper: forged=${forged} refused=${refused} honest=${honest}`);
      expect(forged).toBe(0);
    },
  );

  it("control: a permanently dirty tracked `.gitignore` refuses (status catches the divergence)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "# none\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-qm", "ign"]);
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    // Dirty foreign rule, NEVER restored — the claims-status must see it.
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("EVIDENCE-REFUSED");
  });

  it("control: a committed `.gitignore` rule honestly drops (attested exit 0)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-qm", "ign"]);
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(0);
    const staged = git(root, ["ls-files", "--", "d"]);
    expect(staged.includes("d/normal.txt")).toBe(true);
    expect(staged.includes("d/secret.txt")).toBe(false);
  });
});
