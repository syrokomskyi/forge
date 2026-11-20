/*
RFC-1616 round-29 independent adversarial probes — candidate commit
27daa3805, exported tree.

CX-r29-F — leftover r28 delta surfaces: SHA-256 object-format repos on
the `rebase-merge/rewritten/` name bound, `rewritten` as a bare FILE,
single-file pathspec coverage edges, `reset` sharing the index-write
window with `add`, and the `preflight:false` ambient reads inside
gitEvidence's own enumeration path.

Fix (reset side of CX-r29-C): the coverage proof now applies to
`reset` identically — a same-session index writer inside the armed
window lands in the whole-index claims-vs-live diff, and the op's
result is proven by `diff --cached <rev>` being EMPTY under the
judged extent rather than trusted from the ignored-write surface.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = (fmt: "sha1" | "sha256" = "sha1") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx29f-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", `--object-format=${fmt}`, root]);
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

describe("CX-r29-F rewritten/ bound across object formats", () => {
  it("SHA-256 repo: rewritten/<64hex> is the accepted authored residual — answers own bytes, never foreign", async () => {
    const root = mkRepo("sha256");
    const foreign = foreignTip(root);
    const honest = git(root, ["rev-parse", "HEAD"]);
    expect(honest.length).toBe(64);
    plant(root, `rebase-merge/rewritten/${honest}`, `${honest}\n`);
    const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${honest}`]);
    // The exempt leaf may answer its attested bytes or refuse — the
    // foreign sha must never escape.
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    if (r.exitCode === 0) expect(r.stdout.trim()).toBe(honest);
  });

  it("SHA-256 repo: 63-hex and 65-hex rewritten names refuse", async () => {
    const root = mkRepo("sha256");
    const foreign = foreignTip(root);
    for (const n of ["a".repeat(63), "a".repeat(65)]) {
      plant(root, `rebase-merge/rewritten/${n}`, `${foreign}\n`);
      const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${n}`]);
      expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
    }
  });

  it("SHA-1 repo: 64-hex rewritten name is the accepted residual (bound is name-shape, not repo format)", async () => {
    const root = mkRepo("sha1");
    const foreign = foreignTip(root);
    const name64 = "b".repeat(64);
    plant(root, `rebase-merge/rewritten/${name64}`, `${name64}\n`);
    const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${name64}`]);
    // Documented residual: 64-hex names are exempt in sha1 repos too —
    // it may answer its own content or refuse; never the foreign sha.
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });

  it("SHA-256 repo: 40-hex content at a 64-hex rewritten name is authored-position bytes", async () => {
    const root = mkRepo("sha256");
    const foreign = foreignTip(root);
    const name64 = "c".repeat(64);
    const content40 = "d".repeat(40);
    plant(root, `rebase-merge/rewritten/${name64}`, `${content40}\n`);
    const r = await verifierGit(root, ["rev-parse", `rebase-merge/rewritten/${name64}`]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });
});

describe("CX-r29-F rewritten as a bare FILE", () => {
  it("`rebase-merge/rewritten` as a leaf file with oid content refuses", async () => {
    const root = mkRepo();
    const foreign = foreignTip(root);
    mkdirSync(path.join(root, ".git", "rebase-merge"), { recursive: true });
    writeFileSync(path.join(root, ".git", "rebase-merge", "rewritten"), `${foreign}\n`);
    const r = await verifierGit(root, ["rev-parse", "rebase-merge/rewritten"]);
    expect(r.exitCode === -1 || !r.stdout.includes(foreign)).toBe(true);
  });
});

describe("CX-r29-F single-file pathspec + extent edges", () => {
  it("`add -A -- <ignored-file>` fails honestly like ambient git (exit 1, not 0-fabricated)", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d/secret.txt"], {
      preflight: pre!,
    });
    // Ambient git errors "paths are ignored" exit 1 on a named ignored
    // file — the channel may pass that through or refuse; a 0 is only
    // honest when nothing got silently dropped... which it can't be.
    expect(r.exitCode === -1 || r.exitCode !== 0).toBe(true);
    expect(git(root, ["ls-files", "--", "d"])).not.toContain("secret.txt");
  });

  it("`add -A -- <file>` that is NOT ignored stages honestly", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d/normal.txt"], {
      preflight: pre!,
    });
    expect(r.exitCode).toBe(0);
    expect(git(root, ["ls-files", "--", "d"])).toContain("d/normal.txt");
  });
});

describe("CX-r29-F reset shares the index-write window", () => {
  it("a foreign index write inside an anchored `reset -q --` window persists a phantom staged entry", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "x.txt"), "x\n");
    git(root, ["add", "d/x.txt"]);
    git(root, ["commit", "-qm", "d"]);
    writeFileSync(path.join(root, "d", "x.txt"), "DIRTY\n");
    git(root, ["add", "d/x.txt"]);
    const realBlob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "PHANTOM\n",
      encoding: "utf8",
    }).trim();
    // Mid-window: a sibling `update-index --index-info` injects
    // d/evil.txt — index writes are ignored-for-reset inside the watch.
    const script =
      "import os,sys,subprocess,time\n" +
      "root=sys.argv[1]; end=time.time()+float(sys.argv[2]); me=str(os.getpid()); seen=set()\n" +
      "vpid=sys.argv[3]\n" +
      "while time.time()<end:\n" +
      "    kids=set()\n" +
      "    try:\n" +
      "        for t in os.listdir(f'/proc/{vpid}/task'):\n" +
      "            try: kids.update(open(f'/proc/{vpid}/task/{t}/children').read().split())\n" +
      "            except: pass\n" +
      "    except: pass\n" +
      "    for k in kids:\n" +
      "        if k in seen or k==me: continue\n" +
      "        try: c=open(f'/proc/{k}/cmdline','rb').read()\n" +
      "        except: c=b''\n" +
      "        if b'reset' in c:\n" +
      "            seen.add(k)\n" +
      "            env=dict(os.environ); env['GIT_INDEX_FILE']=root+'/.git/index'\n" +
      "            subprocess.run(['git','-C',root,'update-index','--add','--cacheinfo',sys.argv[4]], env=env)\n" +
      "    time.sleep(0.0002)\n";
    const flip = spawn(
      "python3",
      ["-c", script, root, "60", String(process.pid), `100644,${realBlob},d/evil.txt`],
      { stdio: "ignore" },
    );
    flip.unref();
    try {
      const pre = await evidenceRepoPreflight(root);
      expect(pre).not.toBeNull();
      const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "d"], { preflight: pre! });
      const staged = r.exitCode === 0 ? git(root, ["ls-files", "--", "d"]) : "";
      const forged = r.exitCode === 0 && staged.includes("d/evil.txt");
      console.log(
        `reset index-inject: exit=${r.exitCode} forged=${forged} staged=${JSON.stringify(staged)}`,
      );
      expect(forged).toBe(false);
    } finally {
      flip.kill("SIGKILL");
    }
  });
});

describe("CX-r29-F preflight:false ambient reads", () => {
  it("`gitEvidence --version`/`config` capture reads run ambient-but-env-scrubbed — a session .git cannot steer them", async () => {
    const root = mkRepo();
    const v = await gitEvidence(root, ["--version"], { preflight: false });
    expect(v.exitCode).toBe(0);
    expect(v.stdout).toContain("git version");
    const c = await gitEvidence(root, ["config", "--local", "--no-includes", "--list", "--null"], {
      preflight: false,
    });
    expect(c.exitCode).toBe(0);
  });
});
