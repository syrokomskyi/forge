/*
RFC-1616 round-29 independent adversarial probes — candidate commit
27daa3805, exported tree.

CX-r29-C — `verifyAnchoredAddCoverage` bounds only DROPS and
RULE-VIOLATING stages; it never proves the staged set ⊆ the op's own
expansion. The real index is `anchoredMutationIgnorable`'d out of the
armed watch (the `add`'s own write surface), so a same-UID session
writes `.git/index` mid-window (`update-index --index-info` takes
index.lock the moment the `add` releases it) and lands a staged entry
the judged `add` never produced BEFORE the coverage's `ls-files -s`
enumerates it. The coverage classifies it `newly` (not in the claims
index) but unexplained staged entries fall through unjudged
(`staged_ && src===undefined → continue`), so the verdict escapes
exit 0 with a foreign stage inside the attested window:

  - phantom entry: `d/evil.txt` staged with no worktree file;
  - content swap: `d/normal.txt` restaged to a FOREIGN blob — the
    caller's "staged = worktree bytes" claim serves attacker content.

Fix: `verifyAnchoredMutationCoverage` now diffs the WHOLE post-op
index against the pre-op claims index inside the still-armed window
— every changed entry must sit under the judged pathspec extent,
carry stage 0 only, and for `add` match worktree bytes (`git diff`
drift refuses; a removed entry requires an absent worktree file).
`reset` proves `diff --cached <rev>` empty under the extent. The
live-index reads run on a frozen `/dev/fd`/scratch snapshot because
`git diff` opportunistically refreshes+rewrites the real index, and
a post-drain stat re-check catches any write the armed watch's own
ignored-surface let through.
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
  const root = mkdtempSync(path.join(os.tmpdir(), "cx29c-"));
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
 * /proc-children mutator variant: SIGSTOP the first git child whose
 * argv contains `match`, run `cmd` (a `git -C <root> update-index`
 * injection), SIGCONT. The first coverage child is `ls-files -o` —
 * freezing it holds the armed window open while the foreign index
 * write lands ahead of the `ls-files -s` enumeration.
 */
const startIndexInjector = (match: string, cmd: string, secs = 60) => {
  const script =
    "import os,sys,time\n" +
    "pid=int(sys.argv[1]); pat=sys.argv[2].encode(); cmd=sys.argv[3]; end=time.time()+float(sys.argv[4]); me=str(os.getpid()); seen=set(); retries={}\n" +
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
    "            try: os.system(cmd)\n" +
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
  const child = spawn("python3", ["-c", script, String(process.pid), match, cmd, String(secs)], {
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

describe("CX-r29-C: mid-window foreign index write inflates the attested staged set", () => {
  it(
    "a phantom `d/evil.txt` stage lands before `ls-files -s` — exit 0 with an entry the add never produced",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 25 && forged === 0; attempt++) {
        const root = mkRepo();
        mkdirSync(path.join(root, "d"), { recursive: true });
        writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
        const foreign = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
          input: "FORGED\n",
          encoding: "utf8",
        }).trim();
        const pre = await evidenceRepoPreflight(root);
        expect(pre).not.toBeNull();
        // Freeze the first coverage `ls-files` child; inject the
        // phantom stage while it is stopped → `ls-files -s` sees it.
        const injector = startIndexInjector(
          "ls-files",
          `git -C '${root}' update-index --index-info <<'EOF'\n100644 ${foreign} 0\td/evil.txt\nEOF`,
        );
        try {
          const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], {
            preflight: pre!,
          });
          if (r.exitCode === -1) refused++;
          else {
            const staged = git(root, ["ls-files", "-s", "--", "d"]);
            if (staged.includes("d/evil.txt")) forged++;
            else honest++;
          }
        } finally {
          injector.stop();
        }
      }
      console.log(`phantom-inject: forged=${forged} refused=${refused} honest=${honest}`);
      expect(forged).toBe(0);
    },
  );

  it(
    "a restaged `d/normal.txt` carries a FOREIGN blob — the staged-content claim serves attacker bytes",
    { timeout: 120_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 25 && forged === 0; attempt++) {
        const root = mkRepo();
        mkdirSync(path.join(root, "d"), { recursive: true });
        writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
        const foreign = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
          input: "FORGED\n",
          encoding: "utf8",
        }).trim();
        const pre = await evidenceRepoPreflight(root);
        expect(pre).not.toBeNull();
        const injector = startIndexInjector(
          "ls-files",
          `git -C '${root}' update-index --index-info <<'EOF'\n100644 ${foreign} 0\td/normal.txt\nEOF`,
        );
        try {
          const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], {
            preflight: pre!,
          });
          if (r.exitCode === -1) refused++;
          else {
            const stagedBlob = git(root, ["rev-parse", ":d/normal.txt"]);
            if (stagedBlob === foreign) forged++;
            else honest++;
          }
        } finally {
          injector.stop();
        }
      }
      console.log(`blob-swap: forged=${forged} refused=${refused} honest=${honest}`);
      expect(forged).toBe(0);
    },
  );

  it("control: a quiet window stages exactly the worktree expansion", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(0);
    const staged = git(root, ["ls-files", "-s", "--", "d"]);
    expect(staged).toContain("d/normal.txt");
    expect(staged).not.toContain("evil");
  });
});
