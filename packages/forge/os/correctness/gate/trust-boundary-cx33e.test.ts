/*
RFC-1616 round-33 independent adversarial probes — candidate commit
f38db06ae, exported tree.

CX-r33-E — `verifyAnchoredMutationCoverage`'s provenance consult only
runs on `candidates = residual ∪ newly` (:4905), where `residual`
comes from `ls-files -o -z -- <extent>` (:4887) — `-o` EXCLUDES
ignored files. A `.gitignore` planted before the op therefore
removes files from the consult's sight entirely: `add -A -- .`
skips them (git honors the planted worktree rule), `ls-files -o`
omits them, `candidates` never names them, and `finish(null)`
attests a staged-set expansion that committed-policy never
produced — the file that committed rules would have staged is
silently absent from the index.

Meanwhile the planted rule file itself is untracked and unignored,
so the op stages it — the post-op index carries foreign ignore
rules under a tracked name.

Honest outcomes: refused = exitCode -1 (EVIDENCE-REFUSED); honest =
x/hidden staged; forged = exitCode 0 with `x/hidden` unstaged —
committed `.gitignore` does not ignore it, so committed-policy
`add -A` would have staged it. The planted `x/.gitignore` is the
only thing that suppressed the staging.
*/

import { execFileSync } from "node:child_process";
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
  const root = mkdtempSync(path.join(os.tmpdir(), "cx33e-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, ".gitignore"), "visible\n");
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", ".gitignore", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

const staged = (root: string, p: string): boolean => {
  try {
    git(root, ["rev-parse", `:${p}`]);
    return true;
  } catch {
    return false;
  }
};

describe("CX-r33-E: planted .gitignore hides files from `add` coverage — candidates exclude ignored residuals", () => {
  it("add -A passes coverage while a foreign rule suppressed a file committed policy would stage", async () => {
    let forged = 0;
    let refused = 0;
    let honest = 0;
    let lastErr = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      const root = mkRepo();
      writeFileSync(path.join(root, "visible"), "y\n"); // committed-rule match
      mkdirSync(path.join(root, "x"), { recursive: true });
      writeFileSync(path.join(root, "x", ".gitignore"), "hidden\n");
      writeFileSync(path.join(root, "x", "hidden"), "payload\n");
      const pre = await evidenceRepoPreflight(root);
      expect(pre).not.toBeNull();
      const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "."], {
        preflight: pre!,
      });
      if (r.exitCode === -1) {
        refused++;
        lastErr = r.stderr.slice(0, 160);
      } else if (r.exitCode === 0 && !staged(root, "x/hidden")) {
        forged++;
      } else {
        honest++;
      }
    }
    console.log(
      `planted-rule drop through add coverage: forged=${forged} refused=${refused} honest=${honest} last=${lastErr}`,
    );
    expect(forged).toBe(0);
  });
});
