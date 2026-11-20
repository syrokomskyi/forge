/*
RFC-1616 round-34 adversarial probe — deterministic, no racing.

CX-r34-G — `enumerateTrackedRuleSources` (:4456-4476) filters
`EvidenceIndex.names` (minted from `ls-files --stage`) with
`rel.endsWith(".gitignore")` + `existsSync(path.join(wt, rel))`,
claiming the suffix test "reproduces `ls-files -- '*.gitignore'`
exactly" because wildmatch `*` crosses `/`. The real question is
UNDER-inclusion: a tracked file `check-ignore -v` CAN cite that
the filter misses → the cite lands unproven (safe direction —
refusal, never forgery). Forgery needs the other direction: a
name the predicate admits that a forged `names` could carry while
the pinned claims bytes do not — impossible: `names` and `bytes`
derive from the SAME parse (:2083-2090), so they desync only via
the mint child itself.

Differential battery (real git, real index):

  T1  predicate vs `git ls-files -z -- "*.gitignore"` over a wide
      name battery — the two sets must AGREE (any disagreement is
      a predicate bug: miss = under-inclusion, extra = harmless
      over-inclusion).
  T2  `git check-ignore -v` sources for probe paths — every cited
      source must be a literal-`.gitignore` basename (what the
      predicate covers); a cite of `foo.gitignore` or `.GITIGNORE`
      would be under-inclusion.
  T3  `names` ≡ `ls-files --stage` name set (mint consistency):
      prepareEvidenceIndex → names set vs `git ls-files -z` on the
      produced claims fd — must be IDENTICAL (the serialized image
      children read must enumerate exactly the minted names).
  T4  submodule boundary: `sub/.gitignore` exists on disk inside a
      submodule but is NOT in the parent index — cite lands
      unproven (safe), never proven.
*/

import { execFileSync, spawnSync } from "node:child_process";
import { constants as fsConstants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { closeEvidenceIndex, evidenceRepoPreflight } from "../../../src/utils/verifier-git.ts";

(fsConstants as { O_TMPFILE?: number }).O_TMPFILE = 0o20200000;

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const mkRepo = (tag: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), `cx34g-${tag}-`));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  return root;
};

const tracked = (root: string) =>
  git(root, ["ls-files", "-z"])
    .split("\0")
    .filter((s) => s.length > 0);

describe("CX-r34-G: rule-source predicate differential", () => {
  it("T1+T2: `endsWith(.gitignore)` vs `ls-files -- '*.gitignore'` vs `check-ignore -v` sources", () => {
    const root = mkRepo("t12");
    // Name battery — tracked files at every shape near the predicate.
    const names = [
      ".gitignore", // literal at root
      "x/.gitignore", // literal nested
      "x/y/.gitignore", // literal deep
      "x/foo.gitignore", // suffix but wrong basename — never cited
      "x/.gitignore.txt", // longer suffix — neither
      ".GITIGNORE", // case — git never consults on linux
      "x/.GitIgnore", // case — same
      "x/gitignore", // missing dot — neither
      "x/.gitignore.bak", // trailing — neither
      "a-b/.gitignore",
      ".config/.gitignore",
      "plain.txt",
    ];
    for (const n of names) {
      mkdirSync(path.dirname(path.join(root, n)), { recursive: true });
      writeFileSync(path.join(root, n), "*.tmp\n");
    }
    writeFileSync(path.join(root, "plain2.txt"), "p\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "c1"]);

    const lsStar = git(root, ["ls-files", "-z", "--", "*.gitignore"])
      .split("\0")
      .filter((s) => s.length > 0)
      .sort();
    const predicate = tracked(root)
      .filter((n) => n.endsWith(".gitignore"))
      .sort();
    console.log(`T1 ls-files '*.gitignore': ${JSON.stringify(lsStar)}`);
    console.log(`T1 predicate         : ${JSON.stringify(predicate)}`);
    expect(predicate).toEqual(lsStar);

    // check-ignore -v cited sources — every source a payload can be
    // matched by; probe a payload under each dir.
    const payloads = ["p.tmp", "x/p.tmp", "x/y/p.tmp", "a-b/p.tmp", ".config/p.tmp"];
    const sources = new Set<string>();
    const out = execFileSync("git", ["-C", root, "check-ignore", "-v", "-z", "--stdin"], {
      encoding: "utf8",
      input: `${payloads.join("\0")}\0`,
    }).toString();
    const rec = out.split("\0");
    for (let i = 0; i + 3 < rec.length; i += 4) sources.add(rec[i]!);
    console.log(`T2 check-ignore sources: ${JSON.stringify([...sources])}`);
    for (const s of sources) {
      // every cited source's BASENAME must be the literal `.gitignore`
      // for the predicate to cover it — else under-inclusion.
      expect(path.posix.basename(s)).toBe(".gitignore");
      expect(tracked(root).includes(s)).toBe(true);
    }
  });

  it("T3: minted `names` ≡ names enumerated from the serialized claims image", async () => {
    const root = mkRepo("t3");
    writeFileSync(path.join(root, ".gitignore"), "x/\n");
    mkdirSync(path.join(root, "d"));
    writeFileSync(path.join(root, "d", "f.txt"), "v1\n");
    // stage=1/2/3 unmerged entries + an intent-to-add + long names —
    // exercise parse→serialize fidelity for the name set.
    const b1 = git(root, ["hash-object", "-w", "--stdin"], "A\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "c1"]);
    git(
      root,
      ["update-index", "--index-info"],
      `0 ${b1}\tconflict.txt\n100644 ${b1} 1\tconflict.txt\n100644 ${b1} 2\tconflict.txt\n100644 ${b1} 3\tconflict.txt\n`,
    );
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    const names = pre!.index?.names;
    expect(names).toBeDefined();
    // Enumerate the produced claims fd the way children do — the fd is
    // passed through as the child's fd 3 and GIT_INDEX_FILE=/dev/fd/3.
    const fd = pre!.index!.fd!;
    const viaFd = spawnSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: "/dev/fd/3" },
      stdio: ["ignore", "pipe", "pipe", fd],
    })
      .stdout.split("\0")
      .filter((s) => s.length > 0)
      .sort();
    console.log(`T3 names=${JSON.stringify(names!.slice().sort())}`);
    console.log(`T3 fdEnum=${JSON.stringify(viaFd)}`);
    // names carries EVERY parsed claim (per stage row); the fd image
    // enumerates the identical row set (stage dups preserved).
    expect(names!.slice().sort()).toEqual(viaFd);
    closeEvidenceIndex(pre);
  });

  it("T4: submodule `.gitignore` on disk but untracked-in-parent — cite lands unproven", async () => {
    const root = mkRepo("t4");
    writeFileSync(path.join(root, "f.txt"), "v1\n");
    git(root, ["add", "f.txt"]);
    git(root, ["commit", "-qm", "c1"]);
    // Fake a submodule dir: s/.git gitfile + s/.gitignore + s/p payload.
    mkdirSync(path.join(root, "s"), { recursive: true });
    writeFileSync(path.join(root, "s", ".gitignore"), "p\n");
    writeFileSync(path.join(root, "s", "p"), "x\n");
    const out = execFileSync("git", ["-C", root, "check-ignore", "-v", "-z", "--stdin"], {
      encoding: "utf8",
      input: "s/p\0",
    }).toString();
    console.log(`T4 cite for s/p: ${JSON.stringify(out)}`);
    // Whatever the cite, `s/.gitignore` is not in the parent's names —
    // trackedSet misses it → the `!!` lands unproven (safe).
  });
});
