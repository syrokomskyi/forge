/*
RFC-1616 round-23 independent adversarial probes — candidate commit
9d898fed, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.

Round-23 findings:

  CX-r23-A — `mmap(MAP_SHARED)` byte stores emit NO inotify event: a
    same-UID watcher toggled pinned file bytes inside the spawn window
    (tracked `.gitignore` rule forges, loose-ref SHA swaps, held
    claims-index rewrites through `/proc/<pid>/fd/N`) and the armed
    watch drained empty while the child answered from forged bytes.
    The watch now records {ino, ctimeMs} stat pins for every consulted
    file at arm and re-stats them at `settle()` — every write class
    bumps ctime, which no same-UID process can restore — plus a full
    post-drain `reproveEvidenceSurface` for the `objects/` tree the
    pin bound leaves out.

  CX-r23-B — refused/nonzero git answers collapsed into benign
    derivations: `listAnnotated` mapped `-1` and a failed for-each-ref
    to `[]`, `commitsSinceRef`/`pendingLevel` mapped any failure to
    `0`, and `dirtyPaths` swallowed a thrown `statusTracked` into a
    clean `0` — `deriveLineVersion` then printed a fully fabricated
    `source:"version-file"` report downstream flow commands consumed.
    Each site now throws on an unverifiable repo surface and keeps
    only the documented non-repo benign path.

  CX-r23-C — `deltaChangedPaths` mapped a FAILED `git diff` (corrupt
    object, unresolvable tips — any nonzero exit) to `[]`, letting the
    locked-delta gate select a narrower step set than honest. Nonzero
    is now `null` (unprovable) alongside the `-1` refusal.
*/

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  armEvidenceWindowWatch,
  evidenceRepoPreflight,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import { deltaChangedPaths } from "../../flow/pre-lock.ts";
import { deriveLineVersion } from "../../flow/line-version.ts";
import { listLegacyTags, listLineTags } from "../../flow/release-tags.ts";
import type { ReleaseLine } from "../../flow/release-lines.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx23-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/** Byte-for-byte in-place rewrite through `mmap(MAP_SHARED)` — the
 * write class inotify cannot see (CX-r23-A). */
const mmapWrite = (target: string, byte: string) => {
  const r = spawnSync(
    "python3",
    [
      "-c",
      "import mmap,os,sys\n" +
        "fd=os.open(sys.argv[1],os.O_RDWR)\n" +
        "m=mmap.mmap(fd,0)\n" +
        "m[0:1]=sys.argv[2].encode()\n" +
        "m.flush();m.close();os.close(fd)",
      target,
      byte,
    ],
    { encoding: "utf8" },
  );
  expect(r.status).toBe(0);
};

describe("CX-r23-A stat pins catch dirent-invisible writes", () => {
  it("an mmap rewrite of a loose ref is a settle event, not silence", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    const watch = armEvidenceWindowWatch(root, pre!);
    expect(watch).not.toBeNull();
    const ref = path.join(root, ".git", "refs", "heads", "main");
    mmapWrite(ref, "0"); // first nybble of the ref SHA — same length
    const events = await watch!.settle();
    expect(events.some((e) => e.endsWith("refs/heads/main"))).toBe(true);
  });
  it("an mmap toggle on the pinned config refuses the armed window", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    const watch = armEvidenceWindowWatch(root, pre!);
    const cfg = path.join(root, ".git", "config");
    mmapWrite(cfg, "x");
    mmapWrite(cfg, "[");
    const events = await watch!.settle();
    expect(events.some((e) => e.endsWith("config"))).toBe(true);
  });
  it("an mmap rewrite through /proc/<pid>/fd of the held claims index is caught", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    expect(pre?.index).toBeDefined();
    const watch = armEvidenceWindowWatch(root, pre!);
    const fd = pre!.index!.fd;
    if (fd !== undefined) {
      // CX-r23-A channel: procfs exposes the inherited fd to a same-UID
      // child; an mmap store through it fires no inotify event. The
      // mint-time `fchmod 0400` gate (CX-r34-E) makes the O_RDWR open
      // EACCES — the owner's reopen is `chmodat` on the proc-fd path,
      // and that chmod is itself an IN_ATTRIB the window records.
      const r = spawnSync(
        "python3",
        [
          "-c",
          "import mmap,os,sys\n" +
            "os.chmod(sys.argv[1],0o600)\n" +
            "fd=os.open(sys.argv[1],os.O_RDWR)\n" +
            "m=mmap.mmap(fd,0)\n" +
            "m[0:4]=b'PWN!'\n" +
            "m.flush();m.close();os.close(fd)",
          `/proc/${process.pid}/fd/${fd}`,
        ],
        { encoding: "utf8" },
      );
      expect(r.status).toBe(0);
    } else {
      mmapWrite(pre!.index!.path!, "P");
    }
    const events = await watch!.settle();
    expect(events.length).toBeGreaterThan(0);
  });
  it("an mmap rewrite of an extraWatchPaths rule source is an event", async (ctx) => {
    if (!HAS_PY) return ctx.skip();
    const root = mkRepo();
    writeFileSync(path.join(root, ".gitignore"), "secret.txt\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-qm", "ci"]);
    const gi = path.join(root, ".gitignore");
    const pre = await evidenceRepoPreflight(root);
    const watch = armEvidenceWindowWatch(root, pre!, undefined, [gi]);
    mmapWrite(gi, "*");
    const events = await watch!.settle();
    expect(events.some((e) => e.endsWith(".gitignore"))).toBe(true);
  });
  it("a quiet window still settles empty — pins are exact, not paranoid", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    const watch = armEvidenceWindowWatch(root, pre!);
    const events = await watch!.settle();
    expect(events).toEqual([]);
  });
  it("a mid-window .git read stays refused on persistent drift (post-drain reprove)", async () => {
    const root = mkRepo();
    const pre = await evidenceRepoPreflight(root);
    mkdirSync(path.join(root, ".git", "objects", "info"), { recursive: true });
    writeFileSync(path.join(root, ".git", "objects", "info", "alternates"), "/tmp\n");
    const r = await verifierGit(root, ["cat-file", "-t", "HEAD"], { preflight: pre });
    expect(r.exitCode).toBe(-1);
  });
});

describe("CX-r23-B refused reads can no longer collapse into benign versions", () => {
  const line: ReleaseLine = {
    id: "repo",
    tagPrefix: "v",
    versionFile: "package.json",
    paths: [],
  };
  const mkTaggedRepo = () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "package.json"), '{"name":"x","version":"1.2.3"}');
    git(root, ["tag", "-a", "v1.2.3", "-m", "release"]);
    return root;
  };
  it("listLineTags throws when the tag enumeration is refused, never [] ", async () => {
    const root = mkTaggedRepo();
    // A refused-key config refuses every gitEvidence read — the same
    // exit -1 the evidence channel returns under mid-window attack.
    git(root, ["config", "core.fsmonitor", "/bin/true"]);
    await expect(listLineTags(root, line, ambientIo)).rejects.toThrow();
  });
  it("listLegacyTags throws on a refused enumeration instead of reporting none", async () => {
    const root = mkRepo();
    git(root, ["config", "core.fsmonitor", "/bin/true"]);
    await expect(listLegacyTags(root, [line], ambientIo)).rejects.toThrow();
  });
  it("deriveLineVersion rejects rather than printing a fabricated version-file report", async () => {
    const root = mkTaggedRepo();
    git(root, ["config", "core.fsmonitor", "/bin/true"]);
    await expect(deriveLineVersion(root, line, ambientIo)).rejects.toThrow();
  });
  it("an untagged honest repo still derives the version-file value", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "package.json"), '{"name":"x","version":"9.9.9"}');
    const derived = await deriveLineVersion(root, line, ambientIo);
    expect(derived.version).toBe("9.9.9");
    expect(derived.source).toBe("version-file");
  });
});

describe("CX-r23-C a failed diff is unprovable, never an empty delta", () => {
  it("deltaChangedPaths returns null when git diff fails on a corrupt object", async () => {
    const root = mkRepo();
    const b0 = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "b.txt"), "payload\n");
    git(root, ["add", "b.txt"]);
    git(root, ["commit", "-qm", "c2"]);
    const b1 = git(root, ["rev-parse", "HEAD"]);
    // Corrupt a commit object in place — `git diff` fails honestly.
    const obj = path.join(root, ".git", "objects", b1.slice(0, 2), b1.slice(2));
    chmodSync(obj, 0o644); // objects are 444 — loosen before the forge
    writeFileSync(obj, "CORRUPTED-BYTES-THAT-CANNOT-INFLATE");
    const delta = await deltaChangedPaths(ambientIo, root, b0, b1);
    expect(delta).toBeNull();
  });
  it("deltaChangedPaths still returns the honest list on a clean diff", async () => {
    const root = mkRepo();
    const b0 = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "b.txt"), "payload\n");
    git(root, ["add", "b.txt"]);
    git(root, ["commit", "-qm", "c2"]);
    const b1 = git(root, ["rev-parse", "HEAD"]);
    const delta = await deltaChangedPaths(ambientIo, root, b0, b1);
    expect(delta).toContain("b.txt");
  });
});
