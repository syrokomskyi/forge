/*
RFC-1616 round-36 probe — sibling worktree metadir churn.

Background: `<common>/worktrees/` pins and watches originally covered
EVERY metadir. On a host running TWO live session worktrees (the
parallel integrate-latency session mid-rebase beside this one), the
sibling's own admin churn — `REBASE_HEAD`, `MERGE_*`, index refreshes,
reflog appends — fired armed events + pin drift inside OUR consult
windows, so `flow.integrate`'s `statusDirty` provenance consult
refused systematically (FLOW-INT run gr-…-flow.integrate-312c).

A sibling metadir is a CONCURRENT session's write surface that no
consult of ours resolves through (linked-worktree children get
`GIT_DIR` = own metadir — `$GIT_DIR/worktrees/<id>` cannot even be
spelled), so the judged surface narrows to the own metadir while the
`worktrees/` container stays watched (a foreign worktree add/remove
is still honest registry drift).

Probes:

  A — sustained churn INSIDE a sibling metadir during a consult must
      answer honestly (previously: armed-event refuse).
  B — the same churn inside the OWN metadir must still refuse (the
      carve must not hollow the own-worktree evidence).
*/

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifierGit } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

/** Main worktree + two linked worktrees; returns [own-wt, sibling metadir]. */
const mkLinkedRepo = () => {
  const prime = mkdtempSync(path.join(os.tmpdir(), "cx36-main-"));
  tmpdirs.push(prime);
  execFileSync("git", ["init", "-q", "-b", "main", prime]);
  git(prime, ["config", "user.email", "t@t"]);
  git(prime, ["config", "user.name", "t"]);
  writeFileSync(path.join(prime, "f.txt"), "v1\n");
  git(prime, ["add", "f.txt"]);
  git(prime, ["commit", "-qm", "c1"]);
  const own = `${prime}-own`;
  const sib = `${prime}-sib`;
  git(prime, ["worktree", "add", "-q", own]);
  git(prime, ["worktree", "add", "-q", sib]);
  tmpdirs.push(own, sib);
  // Sibling metadir path — `<common>/worktrees/<basename>`: resolve
  // through the sibling's own .git file rather than naming rules.
  const sibMetaDir = git(sib, ["rev-parse", "--git-dir"]);
  return { own, sibMetaDir };
};

const churn = (dir: string, stop: { v: boolean }) => {
  const timer = setInterval(() => {
    if (stop.v) return;
    try {
      // In-place content writes — the dirent stays, the bytes move —
      // plus a novel name so dirent ops are covered too.
      appendFileSync(path.join(dir, "MERGE_MSG"), `# ${Date.now()}\n`);
      writeFileSync(path.join(dir, "CHURN"), `${Date.now()}\n`);
    } catch {
      /* fixture gone */
    }
  }, 3);
  return timer;
};

describe("CX-r36: the judged metadir set is the own one only", () => {
  it("sibling metadir churn during a consult stays honest — never a foreign refuse", async () => {
    const { own, sibMetaDir } = mkLinkedRepo();
    mkdirSync(sibMetaDir, { recursive: true });
    writeFileSync(path.join(sibMetaDir, "MERGE_MSG"), "start\n");
    const honest = git(own, ["rev-parse", "HEAD"]);
    const stop = { v: false };
    const timer = churn(sibMetaDir, stop);
    try {
      for (let i = 0; i < 8; i++) {
        const r = await verifierGit(own, ["rev-parse", "HEAD"]);
        expect(r.exitCode === 0 && r.stdout.trim() === honest).toBe(true);
      }
    } finally {
      stop.v = true;
      clearInterval(timer);
    }
  });

  it("own metadir churn during the same consult still refuses", async () => {
    const { own } = mkLinkedRepo();
    const ownMetaDir = git(own, ["rev-parse", "--git-dir"]);
    const stop = { v: false };
    const timer = churn(ownMetaDir, stop);
    try {
      let refused = 0;
      let honest = 0;
      const expected = git(own, ["rev-parse", "HEAD"]);
      for (let i = 0; i < 8; i++) {
        const r = await verifierGit(own, ["rev-parse", "HEAD"]);
        if (r.exitCode === -1) refused++;
        else if (r.exitCode === 0 && r.stdout.trim() === expected) honest++;
      }
      // Sustained own-surface churn must never yield a clean run of
      // honest verdicts — refuses dominate once any write lands inside
      // a window (the ride-out may let a rare quiet gap through).
      expect(refused, `refused=${refused} honest=${honest}`).toBeGreaterThan(0);
    } finally {
      stop.v = true;
      clearInterval(timer);
    }
  });
});
