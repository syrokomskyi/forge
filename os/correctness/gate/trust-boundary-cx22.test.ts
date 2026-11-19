/*
RFC-1616 round-22 independent adversarial probes — candidate commit
d10d81a6, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.

Round-22 findings:

  CX-r22-A/B/F — the last pre-spawn fingerprint re-prove still ended
    before the Git CHILD opened `.git/shallow`, `info/exclude`, or
    `objects/info/alternates`: a same-UID watcher planted the file in
    the arm→exec window and the child consulted it (rev-list truncation,
    fabricated-clean status, alternate object stores). An inotify
    watchset now covers every dir under gitDir/commonDir, the repoRoot
    and workTree `.git`-node levels, and the claims-index inode for the
    child's whole lifetime — any event drains to refusal.

  CX-r22-C — classifyTopology's lstat-level `.git` check counted a
    dangling symlink or an empty/non-gitdir dir as a worktree node git
    itself SKIPS, pinning GIT_WORK_TREE=<phantom> beside the real
    GIT_DIR — every worktree-anchored verdict then answered about the
    wrong tree. Only nodes git's is_git_directory discovery honors
    classify now; ambiguous surfaces answer `unknown` → refused.

  CX-r22-D — the held claims-index fd stayed writable through
    `/proc/<pid>/fd/N` after the pre-spawn byte re-prove. The fd's inode
    joins the watch via `/proc/self/fd/N`; a procfs rewrite is an event
    → refusal.

  `!!` provenance — `status --ignored` claims are trusted only when
    `check-ignore -v` attributes each verdict to a TRACKED `.gitignore`
    (claims index); a transient worktree `.gitignore` plant (or a
    mid-window rewrite of a tracked one, its inode watched via
    `extraWatchPaths`) leaves the path unproven → `??` dirt /
    ledger-eligible — over-inclusive, never silently hidden.
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  armEvidenceWindowWatch,
  evidenceRepoPreflight,
  unprovenIgnoredPaths,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";
import { gitIsClean } from "../../program/discovery.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx22-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

describe("CX-r22 spawn-window watchset (A/B/F/D)", () => {
  it("a post-preflight .git/shallow plant refuses the judged read", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    writeFileSync(path.join(root, ".git", "shallow"), `${git(root, ["rev-parse", "HEAD"])}\n`);
    // The plant landed after judgment — the armed watch/reprove must
    // turn the read into a refusal, never a truncated rev-list.
    const r = await verifierGit(root, ["rev-list", "HEAD"], { preflight: pre });
    expect(r.exitCode).toBe(-1);
  });
  it("a post-preflight objects/info/alternates plant refuses the judged read", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    const info = path.join(root, ".git", "objects", "info");
    mkdirSync(info, { recursive: true });
    writeFileSync(path.join(info, "alternates"), "/tmp\n");
    const r = await verifierGit(root, ["cat-file", "-t", "HEAD"], { preflight: pre });
    expect(r.exitCode).toBe(-1);
  });
  it("an event inside the armed window is recorded at settle", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    const watch = armEvidenceWindowWatch(root, pre!);
    expect(watch).not.toBeNull();
    // A plant deeper than the top level — recursive coverage.
    const deep = path.join(root, ".git", "info");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "exclude"), "*\n");
    const events = await watch!.settle();
    expect(events.some((e) => e.includes("exclude"))).toBe(true);
  });
  it("a quiet window settles empty — detection is precise, not paranoid", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    const watch = armEvidenceWindowWatch(root, pre!);
    const events = await watch!.settle();
    expect(events).toEqual([]);
  });
  it("a rewrite through /proc/self/fd of the held claims index is an event", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    expect(pre?.index).toBeDefined();
    const watch = armEvidenceWindowWatch(root, pre!);
    if (pre!.index!.fd !== undefined) {
      // CX-r22-D channel: the inherited fd stays addressable via procfs.
      writeFileSync(`/proc/self/fd/${pre!.index!.fd}`, Buffer.from("PWNED"));
    } else {
      writeFileSync(pre!.index!.path!, Buffer.from("PWNED"));
    }
    const events = await watch!.settle();
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("CX-r22-C phantom .git nodes are skipped like git's own discovery", () => {
  it("a dangling .git symlink resolves the parent's real worktree", async () => {
    const root = mkRepo();
    const sub = path.join(root, "sub");
    mkdirSync(sub);
    symlinkSync(path.join(root, "nonexistent-gitdir"), path.join(sub, ".git"));
    const r = await verifierGit(sub, ["rev-parse", "--show-toplevel"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(root);
  });
  it("an empty .git dir resolves the parent's real worktree", async () => {
    const root = mkRepo();
    const sub = path.join(root, "sub");
    mkdirSync(path.join(sub, ".git"), { recursive: true });
    const r = await verifierGit(sub, ["rev-parse", "--show-toplevel"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(root);
  });
  it("an isolated phantom .git refuses rather than inventing a worktree", async () => {
    const orphan = mkdtempSync(path.join(os.tmpdir(), "cx22-orphan-"));
    tmpdirs.push(orphan);
    mkdirSync(path.join(orphan, ".git"));
    const r = await verifierGit(orphan, ["rev-parse", "--is-bare-repository"]);
    expect(r.exitCode).toBe(-1);
  });
});

describe("CX-r22 !! provenance — only tracked .gitignore sources back a verdict", () => {
  it("a committed .gitignore's ignores are proven", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "ignored.log\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-qm", "ignore"]);
    writeFileSync(path.join(root, "ignored.log"), "x\n");
    const unproven = await unprovenIgnoredPaths(root, ["ignored.log"]);
    expect(unproven).not.toBeNull();
    expect(unproven!.size).toBe(0);
  });
  it("a session-planted .gitignore's ignores are unproven — over-inclusive", async () => {
    const root = mkRepo();
    // Untracked rule file: its verdicts can never trace to a commit.
    writeFileSync(path.join(root, ".gitignore"), "ignored.log\n");
    writeFileSync(path.join(root, "ignored.log"), "x\n");
    const unproven = await unprovenIgnoredPaths(root, ["ignored.log"]);
    expect(unproven).not.toBeNull();
    expect(unproven!.has("ignored.log")).toBe(true);
  });
  it("gitIsClean fails closed on a session-planted .gitignore", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "payload.log\n");
    writeFileSync(path.join(root, "payload.log"), "x\n");
    expect(await gitIsClean(root)).toBe(false);
  });
  it("honest committed ignores still read clean", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "ignored.log\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-qm", "ignore"]);
    writeFileSync(path.join(root, "ignored.log"), "x\n");
    expect(await gitIsClean(root)).toBe(true);
  });
});
