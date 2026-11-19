/*
RFC-1616 round-24 independent adversarial probes — candidate commit
731fd9f0, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.

Round-24 finding:

  CX-r24-A — anchored `reset -q -- <paths>` resolves
    `HEAD → refs/heads/<branch> → tree` to decide which blobs the
    index claims, yet `anchoredMutationIgnorable` excluded `/refs/` and
    `/logs/` from BOTH watch events and stat pins (they were classed
    as the op's own write surface), and the evidence fingerprint had no
    `refs/` member at all — `reproveEvidenceSurface` returned true
    after a ref flip. A same-UID loose-ref or `packed-refs` rewrite
    between the caller's preflight and the anchored reset staged
    attacker-controlled blob bytes into governed commit snapshots
    (the `core.module` lockfile read→stage path runs exactly this
    shape).

    Fix: `refs/`+`packed-refs` join the fingerprint (tree compare +
    byte pin at every reprove, anchored pre-spawn included);
    `refs`/`logs` leave `anchoredMutationIgnorable` — the admitted
    ops (`add`, `reset -q --`) write neither, so an event there is
    foreign; existing object files are pinned under anchored ops too
    (`add`/`reset` create objects but never rewrite them); `HEAD`
    stays pinned under anchored.
*/

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  anchoredMutationIgnorable,
  armEvidenceWindowWatch,
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  reproveEvidenceSurface,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx24-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/** A tree the caller never merged — the attacker rewrites the ref tip to it. */
const foreignTip = (root: string) =>
  git(root, ["commit-tree", git(root, ["rev-parse", "HEAD^{tree}"]), "-m", "x"]);

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

describe("CX-r24-A anchored reset can no longer resolve a flipped ref", () => {
  it("a loose-ref flip between preflight and the anchored reset refuses", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "v2\n");
    git(root, ["add", "f.txt"]);
    const pre = await evidenceRepoPreflight(root);
    expect(pre).not.toBeNull();
    writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${foreignTip(root)}\n`);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "f.txt"], { preflight: pre });
    expect(r.exitCode).toBe(-1);
  });
  it("a packed-refs rewrite between preflight and the anchored reset refuses", async () => {
    const root = mkRepo();
    git(root, ["pack-refs", "--all"]);
    writeFileSync(path.join(root, "f.txt"), "v2\n");
    git(root, ["add", "f.txt"]);
    const pre = await evidenceRepoPreflight(root);
    // packed-refs resolves when no loose file exists — repoint it at
    // the foreign tip.
    writeFileSync(
      path.join(root, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted \n${foreignTip(root)} refs/heads/main\n`,
    );
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "f.txt"], { preflight: pre });
    expect(r.exitCode).toBe(-1);
  });
  it("reproveEvidenceSurface now sees a loose-ref flip as drift", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${foreignTip(root)}\n`);
    expect(reproveEvidenceSurface(root, pre!)).toBe(false);
  });
  it("an armed anchored window records a mid-op loose-ref write", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    const watch = armEvidenceWindowWatch(root, pre!, anchoredMutationIgnorable);
    writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${foreignTip(root)}\n`);
    const events = await watch!.settle();
    expect(events.some((e) => e.includes("refs"))).toBe(true);
  });
  it("an mmap rewrite of an existing object under an anchored window is an event", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    const head = git(root, ["rev-parse", "HEAD"]);
    const obj = path.join(root, ".git", "objects", head.slice(0, 2), head.slice(2));
    // `reset`-class arm: the op resolves objects, so existing objects
    // are pinned (`add`-class arms pass `pinObjects:false` — it never
    // resolves them, and its own utime freshen would false-trip).
    const watch = armEvidenceWindowWatch(root, pre!, anchoredMutationIgnorable, undefined, true);
    chmodSync(obj, 0o644); // objects are 444 — the attacker's own write prep
    const r = spawnSync(
      "python3",
      [
        "-c",
        "import mmap,os,sys\n" +
          "fd=os.open(sys.argv[1],os.O_RDWR)\n" +
          "m=mmap.mmap(fd,0)\n" +
          "m[0:1]=b'P'\n" +
          "m.flush();m.close();os.close(fd)",
        obj,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const events = await watch!.settle();
    expect(events.some((e) => e === obj)).toBe(true);
  });
  it("an honest anchored reset still lands on a clean surface", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "v2\n");
    git(root, ["add", "f.txt"]);
    const pre = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "f.txt"], { preflight: pre });
    expect(r.exitCode).toBe(0);
    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).toBe(" M f.txt\n");
  });
  it("an honest anchored add still lands on a clean surface", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "v2\n");
    const pre = await evidenceRepoPreflight(root);
    const r = await evidenceAnchoredGit(root, ["add", "-A", "--", "f.txt"], { preflight: pre });
    expect(r.exitCode).toBe(0);
    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status.trim()).toBe("M  f.txt");
  });
  it("a loose-ref flip under the read path was already refused — regression guard", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${foreignTip(root)}\n`);
    const r = await verifierGit(root, ["rev-parse", "HEAD"], { preflight: pre });
    expect(r.exitCode).toBe(-1);
  });
});
