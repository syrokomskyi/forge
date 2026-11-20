/*
RFC-1616 round-29 independent adversarial probes — candidate commit
27daa3805, exported tree.

CX-r29-A — `verifyAnchoredAddCoverage` source misattribution via a
`.gitignore:`-bearing path component. The coverage proof parses
`check-ignore -v` output as `src:line:pattern\tpathname` and extracts
the source via `pre.indexOf(".gitignore:")` truncation:

    const gi = pre.indexOf(".gitignore:");
    sourceOf.set(line.slice(tab + 1),
      gi === -1 ? pre.slice(0, pre.indexOf(":"))
                : pre.slice(0, gi + ".gitignore".length));

A directory whose NAME embeds `.gitignore:` (legal on Linux —
`v.gitignore:w/`) makes `check-ignore -v` report source
`v.gitignore:w/.gitignore:1:pat`; the truncation yields `v.gitignore` —
a DIFFERENT path. If `v.gitignore` is a tracked+worktree-clean decoy
the drop is "justified" by attested content while the consulted rule
came from an untracked, unjudgeable file. The staged-set proof then
returns null and the anchored `add` escapes exit 0 with a member
silently dropped under FOREIGN rules — exactly the CX-r28-B class the
mechanism exists to refuse.

`unprovenIgnoredPaths` carries the same first-colon truncation
(`line.slice(0, line.indexOf(":"))`) — a `!!` hidden path behind a
colon-dir rule misattributes to the tracked decoy and stays
"proven-ignored" — the status-side verdict hides the payload while a
foreign rule hides it.

Fix: both call sites run `check-ignore -v -z` — records are
`source\0line\0pattern\0pathname\0` and NUL can appear in no field,
so a `.gitignore:`/`:`-bearing directory name can never truncate the
source into a tracked decoy. An unmatched path yields no record at
all — `src === undefined` is unverifiable, same refusal class.
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  unprovenIgnoredPaths,
} from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx29a-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/** The ambient mechanics the hole rides on — asserts git's real output. */
describe("CX-r29-A mechanics: check-ignore -v echoes colon-dir sources verbatim", () => {
  it("sanity: a `.gitignore:`-component dir is a real ignore source and -v reports it raw", () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "v.gitignore:w"), { recursive: true });
    writeFileSync(path.join(root, "v.gitignore:w", ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(root, "v.gitignore:w", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "v.gitignore:w", "normal.txt"), "n\n");
    const out = execFileSync("git", ["-C", root, "check-ignore", "-v", "--stdin"], {
      input: "v.gitignore:w/secret.txt\n",
      encoding: "utf8",
    }).trim();
    // The reported source is the real (untracked) file — the verifier's
    // parser truncates it at the first `.gitignore:` → `v.gitignore`.
    expect(out).toBe("v.gitignore:w/.gitignore:1:secret.txt\tv.gitignore:w/secret.txt");
    // And `add -A` genuinely drops the member — silent shrink in play.
    git(root, ["add", "-A", "--", "v.gitignore:w"]);
    expect(git(root, ["ls-files", "v.gitignore:w"])).not.toContain("secret.txt");
    git(root, ["reset", "-q"]);
  });
});

describe("CX-r29-A: anchored add coverage misattributes a colon-dir ignore source", () => {
  it("a foreign rule inside `v.gitignore:w/` drops a member while `add -A -- v.gitignore:w` exits 0", async () => {
    const root = mkRepo();
    // Tracked, worktree-clean decoy — what the truncated source parses to.
    writeFileSync(path.join(root, "v.gitignore"), "# benign\n");
    git(root, ["add", "v.gitignore"]);
    git(root, ["commit", "-qm", "decoy"]);
    mkdirSync(path.join(root, "v.gitignore:w"), { recursive: true });
    writeFileSync(path.join(root, "v.gitignore:w", ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(root, "v.gitignore:w", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "v.gitignore:w", "normal.txt"), "n\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "v.gitignore:w"], {
      preflight: pre!,
    });
    if (r.exitCode !== -1) {
      // Exit 0 is only honest when the member actually staged.
      const staged = git(root, ["ls-files", "--", "v.gitignore:w"]);
      expect(staged.includes("v.gitignore:w/secret.txt")).toBe(true);
    }
  });

  it("same forge under a bare `add -A` (coverage extent `:/`)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "v.gitignore"), "# benign\n");
    git(root, ["add", "v.gitignore"]);
    git(root, ["commit", "-qm", "decoy"]);
    mkdirSync(path.join(root, "v.gitignore:w"), { recursive: true });
    writeFileSync(path.join(root, "v.gitignore:w", ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(root, "v.gitignore:w", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "v.gitignore:w", "normal.txt"), "n\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A"], { preflight: pre! });
    if (r.exitCode !== -1) {
      const staged = git(root, ["ls-files", "--", "v.gitignore:w"]);
      expect(staged.includes("v.gitignore:w/secret.txt")).toBe(true);
    }
  });

  it("deeper variant: `d/v.gitignore:w/` misattributes to tracked `d/v.gitignore`", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "v.gitignore"), "# benign\n");
    git(root, ["add", "d/v.gitignore"]);
    git(root, ["commit", "-qm", "decoy"]);
    mkdirSync(path.join(root, "d", "v.gitignore:w"), { recursive: true });
    writeFileSync(path.join(root, "d", "v.gitignore:w", ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(root, "d", "v.gitignore:w", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "d", "v.gitignore:w", "normal.txt"), "n\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], { preflight: pre! });
    if (r.exitCode !== -1) {
      const staged = git(root, ["ls-files", "--", "d"]);
      expect(staged.includes("d/v.gitignore:w/secret.txt")).toBe(true);
    }
  });

  it("dry-run variant: `add -n -A --` reports omit the member under a misattributed source", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "v.gitignore"), "# benign\n");
    git(root, ["add", "v.gitignore"]);
    git(root, ["commit", "-qm", "decoy"]);
    mkdirSync(path.join(root, "v.gitignore:w"), { recursive: true });
    writeFileSync(path.join(root, "v.gitignore:w", ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(root, "v.gitignore:w", "secret.txt"), "s\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-n", "-A", "--", "v.gitignore:w"], {
      preflight: pre!,
    });
    // Under -n the "answer" is the would-add report — a foreign rule
    // silently shaping it is the same fabricated claim.
    if (r.exitCode !== -1) {
      expect(r.stdout.includes("secret.txt")).toBe(true);
    }
  });

  it("control: a plain foreign `d/.gitignore` refuses (r28-B fix intact)", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    writeFileSync(path.join(root, "d", "normal.txt"), "n\n");
    writeFileSync(path.join(root, ".gitignore"), "d/secret.txt\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "d"], { preflight: pre! });
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("EVIDENCE-REFUSED");
  });

  it("control: colon-dir WITHOUT a tracked decoy refuses (truncated name is untracked)", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "v.gitignore:w"), { recursive: true });
    writeFileSync(path.join(root, "v.gitignore:w", ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(root, "v.gitignore:w", "secret.txt"), "s\n");
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "v.gitignore:w"], {
      preflight: pre!,
    });
    expect(r.exitCode).toBe(-1);
  });
});

describe("CX-r29-A status side: unprovenIgnoredPaths same truncation", () => {
  it("a `!!` path behind a colon-dir rule misattributes to the tracked decoy — stays proven-ignored", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "v.gitignore"), "# benign\n");
    git(root, ["add", "v.gitignore"]);
    git(root, ["commit", "-qm", "decoy"]);
    mkdirSync(path.join(root, "v.gitignore:w"), { recursive: true });
    writeFileSync(path.join(root, "v.gitignore:w", ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(root, "v.gitignore:w", "secret.txt"), "s\n");
    // `status --ignored` will report `!! v.gitignore:w/secret.txt`; its
    // provenance check must flag it — the rule file is untracked.
    const unproven = await unprovenIgnoredPaths(root, ["v.gitignore:w/secret.txt"]);
    expect(unproven).not.toBeNull();
    expect(unproven!.has("v.gitignore:w/secret.txt")).toBe(true);
  });

  it("control: a real committed nested `.gitignore` stays proven", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "d"), { recursive: true });
    writeFileSync(path.join(root, "d", ".gitignore"), "secret.txt\n");
    git(root, ["add", "d/.gitignore"]);
    git(root, ["commit", "-qm", "real"]);
    writeFileSync(path.join(root, "d", "secret.txt"), "s\n");
    const unproven = await unprovenIgnoredPaths(root, ["d/secret.txt"]);
    expect(unproven).not.toBeNull();
    expect(unproven!.size).toBe(0);
  });
});
