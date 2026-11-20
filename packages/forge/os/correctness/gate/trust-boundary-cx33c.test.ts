/*
RFC-1616 round-33 independent adversarial probes — candidate commit
f38db06ae, exported tree.

CX-r33-C — `unprovenIgnoredPaths`'s `run()` (:5540-5554) and
`enumerateTrackedRuleSources` (:4448-4454) call
`spawnCaptured(resolveGitBin(), argv, { env: verifierGitEnv() +
evidenceSpawnState env })` with NO `evidencePinEnv`. Every other
verifier Git channel (verifierGitSpawn :5230, gitEvidence os/flow/git.ts
:239-248, execEvidenceGit :4333) applies `evidencePinEnv`, which
neutralizes live `.git/config` keys: `core.excludesFile` → /dev/null
(DEADPATH class :2620-ish), `core.fsmonitor`, `diff.external`,
`diff.orderFile`, hooks/filter/sparse levers. The unproven consult
children therefore see the LIVE session config.

Question: can a session-controlled config lever make `check-ignore -v
-z --stdin` or `diff --name-only -z HEAD` (zero-stat claims index)
return a forged answer — either a tracked-source cite the claims never
produced, or a clean report that hides dirt?

Findings (deterministic — no race):
  * `core.excludesFile` demonstrably REACHES the check-ignore child —
    a foreign excludes file is consulted and cited verbatim in the
    `-v` record (test 1). The cite is then compared against the
    claims-fd `*.gitignore` enumeration (:5568-5589) — a verbatim
    excludes path is never a claims-tracked `.gitignore` name, so the
    `!!` member lands in `unproven` → fail-safe direction only.
  * `diff` levers cannot hide dirt on THIS index: the claims index is
    zero-stat (:1941-1975 — stat tuples zeroed so every compare falls
    back to content hashing), `diff.external` is only invoked for
    patch formatting (not name-only classification), attribute-driven
    textconv/command drivers are starved by GIT_ATTR_SOURCE=/dev/null
    in evidenceSpawnState env, and fsmonitor's "valid" flag cannot
    suppress a content compare (empirically `flags: 0` and ` M`
    persists against a lying hook on git 2.53).
  * `ls-files --stage` has no relevant config surface.

Verdict expected: latent hardening gap (missing pin env) but
forge-neutral for the current child set — test asserts honest
outcomes only (unproven includes the member, or null).
*/

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { unprovenIgnoredPaths, verifierGit } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx33c-"));
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

describe("CX-r33-C: `unprovenIgnoredPaths` children run under live .git/config (no evidencePinEnv)", () => {
  it("core.excludesFile reaches the check-ignore child — cite fails into unproven (fail-safe)", async () => {
    const root = mkRepo();
    // Foreign excludes file the claims enumeration can never produce.
    mkdirSync(path.join(root, "exd"), { recursive: true });
    writeFileSync(path.join(root, "exd", ".gitignore"), "hidden\n");
    git(root, ["config", "core.excludesFile", "exd/.gitignore"]);
    writeFileSync(path.join(root, "hidden"), "x\n");
    // With pins the child would never consult exd/.gitignore and
    // check-ignore would exit 1 → the consult returns null (refuse).
    // Under the missing pins the foreign file is consulted; its cite
    // "exd/.gitignore" is not a claims-tracked `*.gitignore` name so
    // `hidden` must land in unproven — honest direction.
    const r = await unprovenIgnoredPaths(root, ["hidden"]);
    expect(r).not.toBeNull();
    expect(r!.has("hidden")).toBe(true);
    // Sanity: same consult with an UNTRACKED .gitignore-named file —
    // identical fail-safe.
    const root2 = mkRepo();
    writeFileSync(path.join(root2, "exd2"), "");
    rmSync(path.join(root2, "exd2"));
    mkdirSync(path.join(root2, "sub"), { recursive: true });
    writeFileSync(path.join(root2, "sub", ".gitignore"), "hidden2\n");
    writeFileSync(path.join(root2, "sub", "hidden2"), "x\n");
    const r2 = await unprovenIgnoredPaths(root2, ["sub/hidden2"]);
    expect(r2 === null || r2.has("sub/hidden2")).toBe(true);
  });

  it("fsmonitor/diff.external levers are REFUSE-class — surface refused before any consult child runs", async () => {
    const root = mkRepo();
    // Dirty the tracked .gitignore — hidden via the foreign rule line.
    writeFileSync(path.join(root, ".gitignore"), "hidden\nvisible\n");
    writeFileSync(path.join(root, "hidden"), "x\n");
    // Live-config levers the pin layer would neutralize:
    const hook = path.join(os.tmpdir(), `cx33c-fsmon-${process.pid}.sh`);
    writeFileSync(hook, '#!/bin/sh\nprintf "OK\\ntok-1\\n"\n');
    const ext = path.join(os.tmpdir(), `cx33c-extdiff-${process.pid}.sh`);
    writeFileSync(ext, "#!/bin/sh\nexit 0\n"); // prints nothing = "no diff"
    spawnSync("chmod", ["+x", hook, ext]);
    git(root, ["config", "core.fsmonitor", hook]);
    git(root, ["config", "diff.external", ext]);
    // judgeEvidenceRepoSurface classifies both as REFUSE — the
    // consult refuses at preflight, before any child spawns. That is
    // the honest outcome.
    const r = await unprovenIgnoredPaths(root, ["hidden"]);
    expect(r).toBeNull();
    const pinned = await verifierGit(root, ["diff", "--name-only", "-z", "HEAD"]);
    expect(pinned.exitCode).toBe(-1);
    expect(pinned.stderr).toContain("EVIDENCE-REFUSED");
  });
});
