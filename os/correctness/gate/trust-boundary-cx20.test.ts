/*
RFC-1616 round-20 independent adversarial probes — candidate commit
53e525fa, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.
Numbering continues from CX-171 (round 19).

Round-20 findings (CX-172 disproven on repro — git refuses `.gitignore`
symlinks with ELOOP, files surface honestly; HOLD):

  CX-173 — populated `.git/modules/<n>` submodule gitdirs sat outside
    every judged surface: the submodule's OWN config
    (`include.path` → `core.fsmonitor=<program>`) executed inside the
    trusted spawn (repro: PWNED on a plain `git status`), and its
    index/info/grafts were never judged. `modules` is now a refuse-class
    shape path judged as a DIRECTORY — any populated entry refuses the
    channel; empty residue stays honest.

  CX-174 — surgical refusal between preflight and spawn mapped `-1`
    evidence reads to benign values: unpushedCommits → [] skipped the
    whole verifier-trailer scan, a refused `remote get-url` skipped the
    parity+anchor block silently, per-sha log failures dropped trailers,
    readCommittedPushConfig → {} misreported "not declared",
    deltaChangedPaths → [] narrowed the locked-delta gate, markerSource
    → basename fallback wrote a fabricated source, isUnborn → true read
    a repo as historyless, currentBranch/branchExists → detached/absent.
    Now: null + FLOW-PUSH-13 error diagnostics, flagged trailer entries,
    thrown errors — unverifiable never reads as clean/absent.

  CX-175 — evidenceAnchoredGit({preflight:null}) skipped the reprove
    guard and spawned with NO resolution pins — an ambient unjudged
    `git add`/`reset` mutating whatever `.git` walk-up found. A null
    anchor now refuses unconditionally.

  CX-176 — filterLedgerEligiblePaths ran `check-ignore` at the proven
    TOPLEVEL while candidates were workspaceRoot-relative: a forge root
    nested below the toplevel let a root-anchored committed rule
    (`/payload.ts`) exclude an authored file it did not match. The
    candidates are now re-based onto the toplevel and `..` escapes are
    unproven.

  CX-177 — classifyTopology answered `selfdir` for a cwd strictly
    INSIDE a non-bare repo's own gitdir (`.git/objects`) — the
    core.bare=true pin then answered "bare" where ambient git honors
    the `bare=false` claim. Inside-gitdir cwds now classify `unknown`
    → refused.
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  verifierGit,
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  reproveEvidenceSurface,
} from "../../../src/utils/verifier-git.ts";
import { branchExists, currentBranch, isUnborn, lastCommitAt } from "../../flow/git.ts";
import { markerSource } from "../../flow/markers.ts";
import { deltaChangedPaths } from "../../flow/pre-lock.ts";
import { filterLedgerEligiblePaths } from "../../compass/handlers/compass-audit-handler.ts";
import { ambientIo } from "../../../src/utils/io.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx20-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/** Plant the cheapest surgical refusal: a shape-violating info/exclude. */
const plantRefusal = (root: string) => {
  const info = path.join(root, ".git", "info");
  mkdirSync(info, { recursive: true });
  writeFileSync(path.join(info, "exclude"), "*\n");
};

describe("CX-173 populated submodule gitdir refuses the channel", () => {
  it("refuses every judged read while .git/modules/<n> is populated", async () => {
    const root = mkRepo();
    const mod = path.join(root, ".git", "modules", "sub");
    mkdirSync(mod, { recursive: true });
    writeFileSync(path.join(mod, "config"), "[core]\nbare = false\n");
    const bare = await verifierGit(root, ["rev-parse", "--is-bare-repository"]);
    expect(bare.exitCode).toBe(-1);
    const status = await verifierGit(root, ["status", "--porcelain"]);
    expect(status.exitCode).toBe(-1);
    // Removing the population restores honesty — the gate is precise,
    // not a blanket "submodules forbidden".
    rmSync(mod, { recursive: true, force: true });
    const gone = await verifierGit(root, ["rev-parse", "--is-bare-repository"]);
    expect(gone.exitCode).toBe(0);
  });
});

describe("CX-179 modules/ population is fingerprint drift, not invisible", () => {
  it("reprove rejects a preflight captured before modules/ was populated", async () => {
    const root = mkRepo();
    // modules/ ABSENT at capture — the preflight judges honestly.
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    expect(pre!.shapeViolations).not.toContain("modules");
    // Populate inside the judgment→spawn window.
    const mod = path.join(root, ".git", "modules", "sub");
    mkdirSync(mod, { recursive: true });
    writeFileSync(path.join(mod, "config"), "[core]\nbare = false\n");
    // Drift must read — without the tree pin the empty-dir fingerprint
    // survived population and the spawn consumed unjudged submodule
    // surface.
    expect(reproveEvidenceSurface(root, pre)).toBe(false);
    // A re-preflight then refuses on the populated dir.
    const post = await evidenceRepoPreflight(root);
    expect(post === null || post.shapeViolations.includes("modules")).toBe(true);
  });
});

describe("CX-174 surgical-refusal polarity", () => {
  it("isUnborn throws instead of reporting a historyless repo", async () => {
    const root = mkRepo();
    plantRefusal(root);
    await expect(isUnborn(root, ambientIo)).rejects.toThrow();
  });
  it("currentBranch throws instead of reporting detached HEAD", async () => {
    const root = mkRepo();
    plantRefusal(root);
    await expect(currentBranch(root, ambientIo)).rejects.toThrow();
  });
  it("branchExists throws instead of reporting the branch absent", async () => {
    const root = mkRepo();
    plantRefusal(root);
    await expect(branchExists(root, ambientIo, "main")).rejects.toThrow();
  });
  it("lastCommitAt throws instead of reporting the ref missing", async () => {
    const root = mkRepo();
    plantRefusal(root);
    await expect(lastCommitAt(root, ambientIo, "main")).rejects.toThrow();
  });
  it("markerSource throws instead of writing a fabricated basename source", async () => {
    const root = mkRepo();
    git(root, ["remote", "add", "origin", "https://example.com/x.git"]);
    plantRefusal(root);
    await expect(markerSource(root, ambientIo)).rejects.toThrow();
  });
  it("deltaChangedPaths returns null instead of a fabricated empty delta", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "g.txt"), "v2\n");
    git(root, ["add", "g.txt"]);
    git(root, ["commit", "-qm", "c2"]);
    const b0 = git(root, ["rev-parse", "HEAD~1"]);
    const b1 = git(root, ["rev-parse", "HEAD"]);
    plantRefusal(root);
    expect(await deltaChangedPaths(ambientIo, root, b0, b1)).toBeNull();
  });
  it("honest git answers still flow: unborn/absent keep their benign polarity", async () => {
    const root = mkRepo();
    // No refusal planted — exit-1 answers stay honest.
    expect(await isUnborn(root, ambientIo)).toBe(false);
    expect(await branchExists(root, ambientIo, "nosuch")).toBe(false);
    expect(await currentBranch(root, ambientIo)).toBe("main");
  });
});

describe("CX-175 anchored mutation with a null judgment refuses", () => {
  it("evidenceAnchoredGit({preflight:null}) never spawns", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "new.txt"), "n\n");
    const r = await evidenceAnchoredGit(root, ["add", "--", "new.txt"], { preflight: null });
    expect(r.exitCode).toBe(-1);
    // The mutation must not have landed in ANY index.
    expect(git(root, ["status", "--porcelain"])).toContain("?? new.txt");
  });
});

describe("CX-176 check-ignore candidates re-base onto the toplevel", () => {
  it("a root-anchored committed rule cannot exclude a nested-workspace payload", async () => {
    const root = mkRepo();
    // Repo toplevel == `root`; the forge workspace is `root/forge/`.
    writeFileSync(path.join(root, ".gitignore"), "/payload.ts\n");
    mkdirSync(path.join(root, "forge"), { recursive: true });
    writeFileSync(path.join(root, "forge", "payload.ts"), "p\n");
    writeFileSync(path.join(root, "payload.ts"), "root-level\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-qm", "ignore"]);
    const ws = path.join(root, "forge");
    const eligible = await filterLedgerEligiblePaths(ws, ["payload.ts"]);
    // `/payload.ts` anchors at the TOPLEVEL — forge/payload.ts does NOT
    // match, so the authored file stays audit-eligible.
    expect(eligible.has("payload.ts")).toBe(true);
  });
});

describe("CX-177 cwd inside a gitdir is unprovable, not selfdir", () => {
  it("verifierGit refuses reads with cwd inside a non-bare repo's .git", async () => {
    const root = mkRepo();
    const inside = path.join(root, ".git", "objects");
    const r = await verifierGit(inside, ["rev-parse", "--is-bare-repository"]);
    expect(r.exitCode).toBe(-1);
  });
});
