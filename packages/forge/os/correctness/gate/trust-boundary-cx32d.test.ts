/*
RFC-1616 round-32 independent adversarial probes — candidate commit
e32510593, exported tree.

CX-r32-D — deterministic edges of the r31 delta:

  1. `unprovenIgnoredPaths` HEAD edges: unborn HEAD, HEAD symref to a
     nonexistent ref, detached HEAD — `diff --name-only -z HEAD` must
     fail closed (null → refused) or answer honestly.
  2. A `.gitignore` flipped to foreign bytes BEFORE function entry:
     `diff HEAD` sees worktree≠committed → unproven → the pin baseline
     can never launder foreign bytes (r31-A closure check).
  3. `info/exclude` cite: planted `.git/info/exclude` hides `sub/payload`
     as `!!` — either refuse-on-presence (shape violation) or
     provenance-unproven → payload rejoins. Never silently hidden.
  4. `.gitignore` inside a NESTED repo (`nested/` with its own `.git`):
     check-ignore cites `nested/.gitignore` for `nested/payload`, but
     `status --ignored` never emits `!! nested/payload` (embedded-repo
     boundary) → the path is unreachable for the provenance layer.
  5. Delta-4 snapshot read: `readFileSync(.git/index)` racing a git
     writer — git commits index writes via lock+rename, so a concurrent
     read sees old-or-new, never torn (property check over 200 reads).
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unprovenIgnoredPaths } from "../../../src/utils/verifier-git.ts";
import { statusDirty } from "../../flow/git.ts";
import { ambientIo } from "../../../src/utils/io.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx32d-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, ".gitignore"), "x\n");
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "c1"]);
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "sub", "payload"), "EVIL\n");
  return root;
};

describe("CX-r32-D: deterministic `unprovenIgnoredPaths` edges", () => {
  it("unborn HEAD — `diff HEAD` fails → null (refused, fail-closed)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cx32d-unborn-"));
    tmpdirs.push(root);
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "t"]);
    writeFileSync(path.join(root, ".gitignore"), "sub/\n");
    git(root, ["add", ".gitignore"]); // staged, never committed
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "sub", "payload"), "EVIL\n");
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).toBeNull();
  });

  it("HEAD symref to a nonexistent ref → null (refused)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    git(root, ["add", ".gitignore"]);
    writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/nonexistent\n");
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).toBeNull();
  });

  it("foreign `.gitignore` flipped BEFORE entry — dirty-vs-HEAD → unproven (honest)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).not.toBeNull();
    expect([...unproven!]).toContain("sub/payload");
  });

  it("staged foreign `.gitignore` — staged-vs-committed divergence → unproven", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    git(root, ["add", ".gitignore"]);
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).not.toBeNull();
    expect([...unproven!]).toContain("sub/payload");
  });

  it("`.git/info/exclude` hides `sub/payload` — refuse-on-presence or unproven, never silent", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    writeFileSync(path.join(root, ".git", "info", "exclude"), "sub/\n");
    // sanity: the plant produces the !! claim
    const st = git(root, ["status", "--porcelain", "-uall", "--ignored"]);
    expect(st).toContain("!! sub/payload");
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    // Either the channel refuses outright (info/exclude is a shape
    // violation) or the cite lands unproven — never proven-hidden.
    if (unproven !== null) {
      expect([...unproven]).toContain("sub/payload");
    }
    let d: Awaited<ReturnType<typeof statusDirty>> | null = null;
    try {
      d = await statusDirty(root, ambientIo);
    } catch {
      d = null; // flow-side "unverifiable" refusal — equally honest
    }
    if (d !== null) {
      expect(d.entries.some((e) => e.slice(3).includes("sub/payload"))).toBe(true);
    }
  });

  it("nested-repo `.gitignore` cite — `nested/payload` never appears as `!!` (unreachable)", async () => {
    const root = mkRepo();
    execFileSync("git", ["init", "-q", "-b", "x", path.join(root, "nested")]);
    git(path.join(root, "nested"), ["config", "user.email", "t@t"]);
    git(path.join(root, "nested"), ["config", "user.name", "t"]);
    writeFileSync(path.join(root, "nested", ".gitignore"), "payload\n");
    writeFileSync(path.join(root, "nested", "payload"), "EVIL\n");
    git(path.join(root, "nested"), ["add", "-A"]);
    git(path.join(root, "nested"), ["commit", "-qm", "n1"]);
    // check-ignore DOES descend and cite the nested rule…
    const cite = git(root, ["check-ignore", "-v", "-z", "--stdin"], "nested/payload\0");
    expect(cite).toContain("nested/.gitignore");
    // …but status never emits `!! nested/payload` — the embedded-repo
    // boundary collapses `nested/` to `??`, so the provenance layer can
    // never be asked about it.
    const st = git(root, ["status", "--porcelain", "-uall", "--ignored"]);
    expect(st).not.toContain("!! nested/payload");
    expect(st).not.toContain("!! nested");
  });

  it("detached HEAD — `diff HEAD` resolves the detached commit → honest verdict", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    git(root, ["checkout", "-q", "--detach", "HEAD"]);
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).not.toBeNull();
    expect([...unproven!]).toContain("sub/payload");
  });

  it(
    "index read atomicity: concurrent lock+rename writer → reads see old-or-new, never torn",
    { timeout: 30_000 },
    async () => {
      const root = mkRepo();
      const indexPath = path.join(root, ".git", "index");
      const { spawn } = await import("node:child_process");
      const writer = spawn(
        "python3",
        [
          "-c",
          "import subprocess,time\n" +
            "end=time.time()+4\n" +
            "while time.time()<end:\n" +
            `    subprocess.run(['git','-C','${root}','update-index','--refresh'],capture_output=True)\n`,
        ],
        { stdio: "ignore" },
      );
      try {
        // 400 reads against a writer committing via lock+rename — every
        // readFileSync must see a complete DIRC image (old or new).
        let torn = 0;
        for (let i = 0; i < 400; i++) {
          const b = readFileSync(indexPath);
          if (b.length < 12 || b.subarray(0, 4).toString() !== "DIRC") torn++;
        }
        expect(torn).toBe(0);
      } finally {
        writer.kill("SIGKILL");
      }
    },
  );
});
