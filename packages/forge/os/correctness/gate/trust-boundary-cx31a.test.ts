/*
RFC-1616 round-31 independent adversarial probes — candidate commit
8f18df089, exported tree.

CX-r31-A — `unprovenIgnoredPaths`' byte-binding diffs worktree `.gitignore`
bytes against a claims index minted at the DIFF child's own call instant —
i.e. against the session's STAGED intent, never against committed policy.
The "proven" predicate is therefore fully satisfiable by a session-authored
rule: stage the foreign `.gitignore` blob into the real index
(`git update-index --cacheinfo` / `git add`) and the worktree bytes the
`check-ignore` child consults equal the staged blob the `diff` child
compares against.

Attack shape — PLANTED STATE, no race:

  t0  `.gitignore` committed as `x` (legitimately tracked).
  t1  Attacker writes `sub/` into worktree `.gitignore` AND stages that
      blob into the real index. `sub/payload` is the payload to hide.
  t2  `status --porcelain` reports ` M .gitignore` + `!! sub/payload`.
  t3  unprovenIgnoredPaths(root, ["sub/payload"]):
      - `ls-files -z -- "*.gitignore"`  → trackedSet = {.gitignore}
      - `check-ignore -v -z`            → cites `.gitignore` for sub/payload
      - `diff --name-only -z` on a claims index minted AFTER the stage →
        worktree `sub/` bytes == staged blob → CLEAN → dirtySrc empty
      - srcStats ino+ctime stable → PROVEN → "sub/payload" omitted from
        the unproven set — provenance forged.

The caller-visible residual: ` M .gitignore` still lists (the staged-blob
tell) so a whole-tree "is clean" gate stays dirty, but every PATH-LEVEL
verdict — `isDirtyPath("sub/payload")`, `statusDirty` entry lists — loses
the member the provenance layer was built to recover (CX-r30-A's hidden
payload). The function contract ("proven only when backed by TRACKED,
CLEAN-vs-claims bytes") is forged: no commit owns `sub/`.

Control: unstaged foreign `.gitignore` → `diff` reports it dirty →
`sub/payload` IS unproven — the fix works when the claims basis is honest.

Fix: `unprovenIgnoredPaths` binds each cited source's worktree bytes to
HEAD (`diff --name-only -z HEAD` whole-tree dirty set) — the committed
baseline the claims index cannot fabricate: a staged-only `.gitignore`
appears as new-vs-HEAD → dirty → unproven; a committed source edited
in the worktree diverges → unproven. On an unborn HEAD the consult
fails → `null` refusal, the fail-closed direction.
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unprovenIgnoredPaths } from "../../../src/utils/verifier-git.ts";
import { statusDirty } from "../../flow/git.ts";
import { gitIsClean } from "../../program/discovery.ts";
import { ambientIo } from "../../../src/utils/io.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx31a-"));
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

const statusLines = (root: string) => git(root, ["status", "--porcelain", "-uall", "--ignored"]);

describe("CX-r31-A: `unprovenIgnoredPaths` attests session-STAGED rule bytes", () => {
  it("staged foreign `.gitignore` blob: `sub/payload` omitted from unproven — provenance forged", async () => {
    const root = mkRepo();
    // Foreign rule bytes: `sub/` hides the payload. Stage them so the
    // claims index minted inside the diff child carries the same blob.
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    git(root, ["add", ".gitignore"]);
    const st = statusLines(root);
    expect(st).toContain("M  .gitignore");
    expect(st).toContain("!! sub/payload");

    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).not.toBeNull();
    // THE HOLE: the `!!` is called proven although no commit owns `sub/`.
    expect([...unproven!]).toContain("sub/payload");
  });

  it("caller level: `statusDirty` hides the payload member behind the staged rule", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    git(root, ["add", ".gitignore"]);
    const d = await statusDirty(root, ambientIo);
    // ` M .gitignore` is visible (the staged tell) — but `sub/payload`
    // must rejoin the verdict as `??` dirt, not stay hidden.
    const memberHidden = !d.entries.some((e) => e.slice(3).includes("sub/payload"));
    expect(memberHidden).toBe(false);
    expect(d.entries.some((e) => e.includes(".gitignore"))).toBe(true);
  });

  it("control: unstaged foreign `.gitignore` — payload IS unproven (fix works on honest basis)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    const unproven = await unprovenIgnoredPaths(root, ["sub/payload"]);
    expect(unproven).not.toBeNull();
    expect([...unproven!]).toContain("sub/payload");
    const d = await statusDirty(root, ambientIo);
    expect(d.entries.some((e) => e.slice(3).includes("sub/payload"))).toBe(true);
  });

  it("caller level: `gitIsClean` stays false on the staged tell — whole-verdict honest", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "x\nsub/\n");
    git(root, ["add", ".gitignore"]);
    // `M .gitignore` keeps the whole-tree verdict dirty — the forgery is
    // scoped to the member-level provenance answer.
    expect(await gitIsClean(root)).toBe(false);
  });
});
