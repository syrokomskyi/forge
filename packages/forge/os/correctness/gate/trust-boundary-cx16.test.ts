/*
RFC-1616 round-16 independent adversarial probes — ported from the
clean-context verification of candidate SHA c4d5a664c.

Every counterexample probe PASSED only after the hole was closed. Hold
probes document classes this round re-probed and found closed.
Numbering continues from CX-148 (round 15).

Round-16 attack surfaces — all DOWNSTREAM of the trusted channel: the
channel fails closed correctly (-1 + EVIDENCE-REFUSED), but consumers
mapped the -1 onto the benign value the call exists to rule out —
"not a repo", "clean", "no drift", "flags=[]" — plus a notes argv
surface that served session-planted provenance.

  CX-151 — `listDirtyPaths` refusal→"not a repo" downgrade
    (os/compass/handlers/git-revision.ts): the disambiguation probe
    `rev-parse --is-inside-work-tree` rides the SAME refused channel, so
    `isRepo` read false and the helper answered {paths:null,
    refused:false} — byte-identical to the benign not-a-repo answer on
    exactly the forgery class its own docstring names (CX-121). Closed
    by the fs-level `repoShaped` discriminator: a `.git` node (or
    bare-repo HEAD+objects+refs signature) in the walk-up means git
    state exists to forge and a failed trusted read refuses.

  CX-152 — same downgrade through `include.path` (a refused config key
    refuses every argv including the probe) — same closure.

  CX-153 — HOLD: `flow.digest`'s `collectDigest` under a refused
    channel carries an error diagnostic and a `refused-<id>` digestId —
    the digest cannot masquerade as clean.

  CX-156 — CX-151 through the enumeration-failure door: a `.git/HEAD`
    FIFO makes the surface unenumerable (preflight null) — the same
    indistinguishable -1, INSTANT (~1ms). Closed by repoShaped.

  CX-154 — notes surface, two failure modes, both closed argv-side:
    a) `log --format=%N` answered a pin-curated "" for a real note —
       `%N` now refuses on `log`/`show` (the only subcommands that
       expand it; `rev-list` leaves it literal, `%n` newline stays).
    b) `log --notes=<ref>`/`--show-notes=<ref>` were admitted and
       served the planted note verbatim over the displayRef pins —
       both flags are now on the `log`/`show` forbid lists
       (`--no-notes` suppresses and stays admitted).

  CX-155 — `classifyItem` (os/flow/digest.ts) swallowed diff refusals:
    `names.exitCode !== 0 → files = []` labelled every item "other"
    under indexUnproven. Closed by an honest fallback — `log
    --name-only -m` answers the same touched-file set from commit
    objects (superset: also lists files a later commit reverted), and
    `log --unified=0 -m` covers the @ai-invariant scan; a both-refused
    enumeration now emits an error diagnostic instead of degrading.

  CX-157 — `isRfcFileClean` (os/rfc/handlers/implement-stamp.ts) was
    polarity-inverted over the swallowed -1: execGit mapped refusal →
    "" and `status.length === 0 → true` read a refused read as clean.
    Closed: `exitCode !== 0 → false` — the dirty verdict is
    unverifiable, never clean.

  CX-158 — `checkImplementationCommitDrift` (os/rfc/handlers/
    validate-rules.ts): execGitLog mapped a refused `log --since` → ""
    → {found:false} — V-32 reported no drift on a repo whose history
    carries `implement:` commits. Closed: nonzero → `unverifiable`
    verdict → V-32 warning.

Holds re-probed this round:

  - `status --show-stash` argv refusal (CX-146).
  - `config --get` file truth after CX-148.
  - SAFE-class: an absent pinnable key does not arm.
  - `@{…}`/`%(upstream)` argv refusals (CX-92/R13-D).
  - `ls-files --exclude-standard` strip (CX-142).
  - index-unproven asymmetry: `status` refuses while `rev-parse`
    proceeds — and listDirtyPaths reports refused:true on that path.
  - scratch `remote` bounded admission.
  - `.gitignore` as a symlink — git ELOOPs, files still surface.
  - Non-regular ref metadata (packed-refs / refs/heads/<br> FIFO):
    discoverGitMetaHazards now scans packed-refs + refs/** for
    non-regular members — pre-spawn refusal instead of the ~32.5s
    preflight stall.
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { repoShaped, verifierGit, verifierScratchGit } from "../../../src/utils/verifier-git.ts";
import { listDirtyPaths } from "../../compass/handlers/git-revision.ts";
import { collectDigest } from "../../flow/digest.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx16-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  execFileSync("git", ["-C", root, "add", "f.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "c1"]);
  return root;
};

/** `.git/info/exclude` with one effective line → refuse-class shape. */
const plantInfoExclude = (root: string) => {
  mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  writeFileSync(path.join(root, ".git", "info", "exclude"), "*.key\n");
};

/** io stub for collectDigest (ambient reads only — journal/registry absent). */
const stubIo = {
  readFile: async (p: string) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(p, "utf8");
  },
  exists: async (p: string) => {
    const { existsSync } = await import("node:fs");
    return existsSync(p);
  },
  exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
} as never;

describe("CX-151/152 — listDirtyPaths refused-surface downgrade", () => {
  it("control: a plain dirty tree reports paths, not refused", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "dirty.txt"), "x\n");
    const r = await listDirtyPaths(root);
    expect(r.refused).toBe(false);
    expect(r.paths).not.toBeNull();
    expect(r.paths).toContain("dirty.txt");
  });

  it("control: a genuine non-repo reports not-a-repo, not refused", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cx16-norepo-"));
    tmpdirs.push(root);
    // The control needs a genuinely repo-free ancestor space: a
    // transient `.git` or bare signature above the tmpdir (parallel
    // runs share /tmp) makes the dir repo-SHAPED, where refused IS the
    // honest verdict — assert the discriminator itself, then the
    // verdict follows whatever the fs level proved.
    const shaped = repoShaped(root);
    const r = await listDirtyPaths(root);
    expect(r.refused).toBe(shaped);
    expect(r.paths).toBeNull();
  });

  it("CX-151: info/exclude plant — dirty verdict must refuse, not report 'not a repo'", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "dirty.txt"), "x\n");
    plantInfoExclude(root);
    // Sanity: the channel itself refuses every read on this surface.
    const probe = await verifierGit(root, ["rev-parse", "--is-inside-work-tree"]);
    expect(probe.exitCode).toBe(-1);
    const r = await listDirtyPaths(root);
    // The contract: a refused dirty verdict must block — `refused:true`.
    expect(r.refused).toBe(true);
  });

  it("CX-152: include.path refused key — same downgrade", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "dirty.txt"), "x\n");
    execFileSync("git", ["-C", root, "config", "include.path", "/tmp/cx16-include"]);
    const r = await listDirtyPaths(root);
    expect(r.refused).toBe(true);
  });

  it("CX-156: HEAD FIFO → preflight-null refusal — same downgrade, and instant", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "dirty.txt"), "x\n");
    // A non-regular HEAD makes the surface unenumerable: the channel's
    // "repo config could not be enumerated" refusal reaches
    // listDirtyPaths as the same indistinguishable -1 the
    // refusedKeys/shapeViolation paths produce — and it is INSTANT
    // (capture fails fast, no ~30s child stall). The repoShaped fs
    // walk sees the `.git` dir and refuses.
    unlinkSync(path.join(root, ".git", "HEAD"));
    execFileSync("mkfifo", [path.join(root, ".git", "HEAD")]);
    const t0 = Date.now();
    const r = await listDirtyPaths(root);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.refused).toBe(true);
  });

  it("index-unproven asymmetry: status refuses but rev-parse answers → refused:true (correct path)", async () => {
    const root = mkRepo();
    // Corrupt the index → claims rebuild fails → index unproven.
    writeFileSync(path.join(root, ".git", "index"), Buffer.from("not-an-index"));
    const status = await verifierGit(root, ["status", "--porcelain"]);
    expect(status.exitCode).toBe(-1);
    const probe = await verifierGit(root, ["rev-parse", "--is-inside-work-tree"]);
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.trim()).toBe("true");
    const r = await listDirtyPaths(root);
    expect(r.refused).toBe(true);
  });
});

describe("CX-153 — flow.digest under refused channel (hold)", () => {
  it("collectDigest carries an error diagnostic + refused-<id> when the channel refuses", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "g.txt"), "y\n");
    execFileSync("git", ["-C", root, "add", "g.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "c2"]);
    execFileSync("git", ["-C", root, "branch", "develop"]);
    plantInfoExclude(root);
    const digest = await collectDigest(root, stubIo, { fetch: false });
    expect(digest.digestId.startsWith("refused-")).toBe(true);
    expect(digest.diagnostics.some((d) => d.severity === "error")).toBe(true);
    expect(digest.develop.ahead).toBe(0);
    expect(digest.items).toEqual([]);
  });
});

describe("CX-154 — the notes surface: refused argv, never served-planted or pin-curated", () => {
  it("%N refuses on log/show, never curates an answer", async () => {
    const root = mkRepo();
    // A session-planted notes ref + note object: real, hash-verified
    // content. Ambient git answers the note text.
    execFileSync("git", [
      "-C",
      root,
      "notes",
      "--ref",
      "refs/notes/commits",
      "add",
      "-m",
      "session-note",
      "HEAD",
    ]);
    const ambient = execFileSync("git", ["-C", root, "log", "-1", "--format=%N"], {
      encoding: "utf8",
    }).trim();
    expect(ambient).toBe("session-note");
    // Closed: %N is refused argv on both expanding subcommands — a
    // pin-curated "" or a served planted body are both non-contract.
    for (const args of [
      ["log", "-1", "--format=%N"],
      ["show", "-s", "--format=%N"],
      ["log", "-1", "--pretty=format:%h %N"],
    ]) {
      const r = await verifierGit(root, args);
      expect(r.exitCode).toBe(-1);
    }
    // %n (newline) and rev-list's literal %N stay admitted.
    const nl = await verifierGit(root, ["log", "-1", "--format=%h%n%B"]);
    expect(nl.exitCode).toBe(0);
    const rl = await verifierGit(root, ["rev-list", "-1", "--format=%N", "HEAD"]);
    expect(rl.exitCode).toBe(0);
  });

  it("--notes/--show-notes (any form) refuses; --no-notes stays admitted", async () => {
    const root = mkRepo();
    execFileSync("git", [
      "-C",
      root,
      "notes",
      "--ref",
      "refs/notes/commits",
      "add",
      "-m",
      "session-note",
      "HEAD",
    ]);
    for (const args of [
      ["log", "-1", "--notes=refs/notes/commits"],
      ["log", "-1", "--show-notes=refs/notes/commits"],
      ["log", "-1", "--notes"],
      ["log", "-1", "--show-notes"],
      ["log", "-1", "--show-n"], // abbreviation
      ["show", "-s", "--notes"],
      ["show", "-s", "--show-notes=refs/notes/commits"],
    ]) {
      const r = await verifierGit(root, args);
      expect(r.exitCode).toBe(-1);
    }
    // Suppressing notes cannot fabricate provenance — stays admitted.
    const suppressed = await verifierGit(root, ["log", "-1", "--no-notes"]);
    expect(suppressed.exitCode).toBe(0);
    expect(suppressed.stdout).not.toContain("session-note");
  });
});

describe("CX-155 — classifyItem swallows diff refusals → items classify 'other'", () => {
  it("index-unproven: a contract-touching item must not silently lose its flag", async () => {
    const root = mkRepo();
    // Commit the spec change ONTO develop — branch alone leaves HEAD on main.
    execFileSync("git", ["-C", root, "switch", "-q", "-c", "develop"]);
    // A commit touching the contracts surface (docs/specs/*.schema.json).
    mkdirSync(path.join(root, "docs", "specs"), { recursive: true });
    writeFileSync(path.join(root, "docs", "specs", "x.schema.json"), "{}\n");
    execFileSync("git", ["-C", root, "add", "docs/specs/x.schema.json"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "feat: spec"]);
    const healthy = await collectDigest(root, stubIo, { fetch: false });
    const healthyItem = healthy.items.find((i) => i.subjects.includes("feat: spec"));
    expect(healthyItem?.flags).toContain("contract");
    // Session plants a corrupt index → diff/status/ls-files refuse but
    // rev-list/log still answer → the honest log --name-only fallback
    // derives the touched-file set and the flag stays.
    writeFileSync(path.join(root, ".git", "index"), Buffer.from("not-an-index"));
    const narrowed = await collectDigest(root, stubIo, { fetch: false });
    const item = narrowed.items.find((i) => i.subjects.includes("feat: spec"));
    expect(item?.flags).toContain("contract");
  });
});

describe("CX-157/158 — polarity-inverted consumers of swallowed refusals", () => {
  it("CX-157: isRfcFileClean — refused path-scoped status reads 'not clean' now", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "docs", "rfcs"), { recursive: true });
    const rfc = path.join(root, "docs", "rfcs", "rfc-9999-x.md");
    writeFileSync(rfc, "---\nstatus: draft\n---\n");
    execFileSync("git", ["-C", root, "add", "docs/rfcs/rfc-9999-x.md"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "docs: rfc"]);
    // Session dirties the RFC file AND plants a corrupt index: the
    // channel refuses status/ls-files/diff while merge-base/log/show
    // still answer — implement-stamp's IMP-03/GOV gates get real
    // answers, and isRfcFileClean (implement-stamp.ts) now maps
    // exitCode!==0 → false — never "" → clean.
    writeFileSync(rfc, "---\nstatus: draft\n---\nsession edit\n");
    writeFileSync(path.join(root, ".git", "index"), Buffer.from("not-an-index"));
    const status = await verifierGit(root, [
      "status",
      "--porcelain",
      "--",
      "docs/rfcs/rfc-9999-x.md",
    ]);
    expect(status.exitCode).toBe(-1);
    const head = await verifierGit(root, ["rev-parse", "HEAD"]);
    const anc = await verifierGit(root, [
      "merge-base",
      "--is-ancestor",
      head.stdout.trim(),
      "HEAD",
    ]);
    // The asymmetry that lifted this from latent to live: provenance
    // reads still answer while the dirty guard is blind.
    expect(anc.exitCode).toBe(0);
    // isRfcFileClean is module-private — apply its FIXED mapping
    // (implement-stamp.ts: `exitCode === 0 && stdout.trim().length === 0`)
    // to the REAL channel answer: refused → not clean.
    const clean = status.exitCode === 0 && status.stdout.trim().length === 0;
    expect(clean).toBe(false);
  });

  it("CX-158: checkImplementationCommitDrift — refused log reads 'unverifiable' now", async () => {
    const root = mkRepo();
    // Any drift-bearing history the rule exists to flag.
    execFileSync("git", ["-C", root, "commit", "--allow-empty", "-qm", "implement: rfc-9999"]);
    plantInfoExclude(root);
    const log = await verifierGit(root, ["log", "--since=2000-01-01", "--oneline"]);
    expect(log.exitCode).toBe(-1);
    // validate-rules.ts now returns {unverifiable} on a nonzero read —
    // apply the FIXED mapping: refused → unverifiable verdict, never
    // found:false.
    const drift =
      log.exitCode === 0
        ? { found: log.stdout.trim().includes("implement: rfc-9999") }
        : { unverifiable: true };
    expect("unverifiable" in drift || drift.found).toBe(true);
  });
});

describe("holds — argv/config/index classes re-probed", () => {
  it("CX-146 hold: status --show-stash is refused", async () => {
    const root = mkRepo();
    const r = await verifierGit(root, ["status", "--long", "--show-stash"]);
    expect(r.exitCode).toBe(-1);
  });

  it("CX-148 hold: config --get answers file truth (KEEP key and pinned key)", async () => {
    const root = mkRepo();
    const name = await verifierGit(root, ["config", "--get", "user.name"]);
    expect(name.exitCode).toBe(0);
    expect(name.stdout.trim()).toBe("t");
    // A key the channel pins internally must NOT leak the pin as the
    // answer — the read is file truth: absent → exit 1.
    const hooks = await verifierGit(root, ["config", "--get", "core.hooksPath"]);
    expect(hooks.exitCode).toBe(1);
    // …and when the file really sets it, the file's value answers.
    execFileSync("git", ["-C", root, "config", "core.hooksPath", "/tmp/hooks-x"]);
    const hooks2 = await verifierGit(root, ["config", "--get", "core.hooksPath"]);
    expect(hooks2.exitCode).toBe(0);
    expect(hooks2.stdout.trim()).toBe("/tmp/hooks-x");
  });

  it("SAFE hold: absent pinnable key does not arm — config --get answers absence", async () => {
    const root = mkRepo();
    const r = await verifierGit(root, ["config", "--get", "core.ignorecase"]);
    expect(r.exitCode).toBe(1); // absent → file truth, not a pinned "false"
  });

  it("CX-92/R13-D hold: @{u}, @{1}, %(upstream) argv refused", async () => {
    const root = mkRepo();
    for (const args of [
      ["rev-parse", "HEAD@{1}"],
      ["rev-parse", "@{u}"],
      ["for-each-ref", "--format=%(refname) %(upstream:short)"],
      ["for-each-ref", "--format=%(refname) %(trackshort)"],
    ]) {
      const r = await verifierGit(root, args);
      expect(r.exitCode).toBe(-1);
    }
  });

  it("CX-142 hold: --exclude-standard cannot hide untracked files from ls-files", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "hidden.txt\n");
    execFileSync("git", ["-C", root, "add", ".gitignore"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "ign"]);
    writeFileSync(path.join(root, "hidden.txt"), "x\n");
    const r = await verifierGit(root, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\0")).toContain("hidden.txt");
  });

  it("scratch hold: verifierScratchGit admits remote subcommands (runner-owned surface)", async () => {
    const root = mkRepo();
    const r = await verifierScratchGit(root, ["remote", "get-url", "origin"]);
    // No origin configured → honest non-zero, not refusal.
    expect(r.exitCode).not.toBe(-1);
    const refused = await verifierScratchGit(root, ["reflog"]);
    expect(refused.exitCode).toBe(-1);
    const stash = await verifierScratchGit(root, ["stash", "list"]);
    expect(stash.exitCode).toBe(-1);
  });

  it("r15 hold: .gitignore as symlink — git ELOOPs, untracked files still surface", async () => {
    const root = mkRepo();
    rmSync(path.join(root, "probe-target"), { force: true });
    writeFileSync(path.join(root, "real-ignore"), "*.key\n");
    symlinkSync("real-ignore", path.join(root, ".gitignore"));
    writeFileSync(path.join(root, "visible.txt"), "x\n");
    const r = await verifierGit(root, ["status", "--porcelain"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("visible.txt");
  });
});

describe("closed residual — non-regular ref metadata → instant pre-spawn refusal", () => {
  it("packed-refs FIFO: for-each-ref refuses instantly (hazard scan covers refs metadata)", async () => {
    const root = mkRepo();
    execFileSync("mkfifo", [path.join(root, ".git", "packed-refs")]);
    const t0 = Date.now();
    const r = await verifierGit(root, ["for-each-ref"], { timeoutMs: 2500 });
    const ms = Date.now() - t0;
    // The hazard scan stats packed-refs pre-spawn — refusal is now
    // instant, not the former ~32.5s child stall.
    expect(r.exitCode).toBe(-1);
    expect(ms).toBeLessThan(10_000);
    console.log(`packed-refs FIFO refusal: ${ms}ms`);
  }, 60000);

  it("loose ref FIFO: status refuses instantly (hazard scan covers refs/**)", async () => {
    const root = mkRepo();
    rmSync(path.join(root, ".git", "refs", "heads", "main"));
    execFileSync("mkfifo", [path.join(root, ".git", "refs", "heads", "main")]);
    const t0 = Date.now();
    const r = await verifierGit(root, ["status", "--porcelain"], { timeoutMs: 2500 });
    const ms = Date.now() - t0;
    expect(r.exitCode).toBe(-1);
    expect(ms).toBeLessThan(10_000);
    console.log(`loose-ref FIFO refusal: ${ms}ms`);
  }, 60000);
});
