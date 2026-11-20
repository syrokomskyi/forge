/*
RFC-1616 round-29 self-review edge probes — argv-parse tightening
landed as a fast-follow on the r29 fix commit.

`verifyAnchoredMutationCoverage` must parse `reset` argv the way git
itself does: `git reset [-q] <arg>` WITHOUT `--` tries the first
non-flag token as a rev — an unresolvable one begins the pathspec
list with the rev defaulting to HEAD (verified ambiently:
`git reset -q d` on a directory unstages it; `rev-parse --verify
d^{tree}` exits 128). Judging the token as a rev unconditionally
would feed a pathspec to `diff --cached` and refuse an honest
`reset -q <dir>`.

Conversely, `git reset -q HEAD` (no `--`, no paths) is a MIXED reset
— it writes `ORIG_HEAD`, which is NOT in `anchoredMutationIgnorable`'s
op-write whitelist (index/objects only). The armed watch correctly
refuses it: only `reset [-q] [<rev>] -- <paths>` is the covered
mutation surface.
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceAnchoredGit, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "r29-edge-"));
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  mkdirSync(path.join(root, "d"));
  writeFileSync(path.join(root, "d", "x.txt"), "x\n");
  writeFileSync(path.join(root, "e.txt"), "y\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "c1"]);
  return root;
};

describe("r29 edge — reset argv forms", () => {
  it("reset -q <dir> without -- is an honest pathspec reset to HEAD", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "d", "x.txt"), "x\nmod\n");
    execFileSync("git", ["-C", root, "add", "d/x.txt"]);
    const pf = await evidenceRepoPreflight(root);
    expect(pf).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "d"], { preflight: pf! });
    expect(r.exitCode).toBe(0);
    const st = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    expect(st).toContain(" M d/x.txt");
  });

  it("reset -q <rev> without -- is a mixed reset — ORIG_HEAD is not the op's whitelisted surface (refuses)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "d", "x.txt"), "x\nmod\n");
    execFileSync("git", ["-C", root, "add", "d/x.txt"]);
    const pf = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "HEAD"], { preflight: pf! });
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("EVIDENCE-REFUSED");
  });

  it("reset -q HEAD -- <dir> pathspec after --", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "d", "x.txt"), "x\nmod\n");
    execFileSync("git", ["-C", root, "add", "d/x.txt"]);
    const pf = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "HEAD", "--", "d"], {
      preflight: pf!,
    });
    expect(r.exitCode).toBe(0);
  });
});
