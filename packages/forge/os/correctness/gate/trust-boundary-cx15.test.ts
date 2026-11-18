/*
<MODULE_CONTRACT>
RFC-1616 round-15 independent adversarial probes — clean-context
verification of the external-verification trust boundary, candidate
SHA f5202528c (refuted; closed in the r15 fix commit).

Every counterexample probe FAILS while the hole is live and PASSES once
closed. Hold probes PASS today — they document classes this round
re-probed and found closed. Numbering continues from CX-144 (round 14).

Round-15 attack surfaces:

  CX-145 — fingerprint blind spot beneath symlinked dirs inside
    fingerprinted trees. `enumerateTreeFiles` records a SYMLINK entry
    ({link, target-dir stat}) and never descends into it, while git
    AND the loose-object/pack scans DO descend (readdirSync follows
    symlinks). A same-uid session makes `.git/objects/<fan>` (or
    `objects/pack`) a symlink into a session dir whose member files
    verify clean at preflight; an in-place member content rewrite
    afterwards (chmod +w; write; same inode — directory ctime is
    untouched) leaves every fingerprint observable unchanged. On the
    cached OriginGit channel `reproveEvidenceSurface` then passes
    forever and the spawn serves rewritten loose bytes / a rewritten
    idx+pack pair under real sha names — git never re-hashes loose
    objects or re-verifies packs on read. CLOSED by refuse-on-presence:
    the enumeration marks every symlink-to-directory leaf `linkDir`,
    the judge refuses the channel on any such leaf inside
    `objects/`/`worktrees/` (git never creates them), and the loose/
    pack scans skip the descent — matching the `worktrees/<id>`
    Dirent-level refusal that already held (CX-147).

  CX-146 — `status --show-stash` was admitted by the evidence argv
    table (status forbade only --branch/-b). In long format it emits
    "Your stash currently has N entries" where N is the number of
    `.git/logs/refs/stash` REFLOG lines — session-fabricable with no
    real stash objects: the CX-92 exclusion class. CLOSED by argv
    refusal (`--show-stash` joins the status forbid list; abbreviated
    spellings over-match safe).

  CX-147 — HOLD: the well-formedness judge already refuses a symlinked
    `worktrees/<id>` metadir (`e.isDirectory()` on the Dirent is false
    for symlinks). The objectsDir sibling lacked the same check —
    CX-145a/b — now aligned.

  CX-148 — `config --get`/`--get-all`/`--get-regexp` answered the
    verifier's pins, not file truth: every pinned key returned the pin
    (unclassified → "", SAFE → safe value, upstream → "") while
    `config --local --no-includes --list` on the same channel served
    file truth. CLOSED: config reads invoke no levers, so
    `evidencePinArgs` now holds back EVERY pin on `config` — not just
    hooksPath — and `--get*` answers file truth end to end.

Re-probe holds asserted here:
  - `.gitignore` as a symlink: git itself refuses to read it (ELOOP) —
    untracked files still surface; not a hiding lever.
  - `--pathspec-from-file`/`--pathspec-file-nul` on table commands:
    git 2.53 rejects the flag on status/diff/log/rev-list/ls-files/
    grep — an admitted argv can only fail honestly.
  - In-place loose-object rewrite under a REAL fanout dir: dir member
    stat drifts → re-preflight → loose memo misses → rehash → refuse.
  - `runBatchBytes`/`showMany` forged loose → per-record null (rehash
    degrade).
  - scratch `remote` channel keeps uploadpack/refused-key blocks.
</MODULE_CONTRACT>
*/

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { verifierGit, verifierScratchGit } from "../../../src/utils/verifier-git.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx15-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  return root;
};

/** Loose-object file bytes that inflate to `<type> <n>\0<body>`. */
const looseBytes = (type: string, body: string) =>
  deflateSync(Buffer.from(`${type} ${body.length}\0${body}`));

/**
 * In-place content rewrite: same inode, no dir-entry change — the
 * containing directory's ctime is untouched, which is exactly what the
 * symlinked-subdir fingerprint entry watches.
 */
const rewriteInPlace = (p: string, bytes: Buffer) => {
  try {
    chmodSync(p, 0o644);
  } catch {
    /* already writable */
  }
  writeFileSync(p, bytes);
};

/** Move a `.git/objects/<subdir>` behind a symlink into a session store. */
const symlinkSubdir = (root: string, rel: string, store: string) => {
  const dir = path.join(root, ".git", rel);
  for (const f of readdirSync(dir)) renameSync(path.join(dir, f), path.join(store, f));
  rmdirSync(dir);
  symlinkSync(store, dir);
};

describe("trust-boundary CX-145: symlinked objects subdir — member rewrite invisible to fingerprint", () => {
  it("CX-145a: loose object behind symlinked `objects/<fan>` — cached OriginGit serves forged bytes after in-place rewrite", async () => {
    const root = mkRepo();
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "clean-payload",
      encoding: "utf8",
    }).trim();
    const store = mkdtempSync(path.join(os.tmpdir(), "cx15-store-"));
    tmpdirs.push(store);
    symlinkSubdir(root, path.join("objects", blob.slice(0, 2)), store);

    const og = createOriginGit(root);
    // Refuse-on-presence: the symlinked fanout is a shape violation —
    // the channel refuses from the first read, never serving anything.
    const first = await og.run!(["cat-file", "-p", blob]);
    expect(first).toBeNull();

    // In-place rewrite inside the symlink target — the fingerprint only
    // records the `objects/<fan>` symlink entry ({link, target-dir
    // stat}), so the reprove passes while the member is forged.
    rewriteInPlace(path.join(store, blob.slice(2)), looseBytes("blob", "FORGED-BYTES"));

    const second = await og.run!(["cat-file", "-p", blob]);
    // Contract: real bytes or refusal (null). Forged content under the
    // real sha is the live counterexample.
    expect(second === null || second === "clean-payload").toBe(true);
  });

  it("CX-145b: forged idx+pack pair behind symlinked `objects/pack` — cached OriginGit serves a real sha's forged bytes", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "real");
    execFileSync("git", ["-C", root, "add", "f.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "real"]);
    execFileSync("git", ["-C", root, "repack", "-adq"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const store = mkdtempSync(path.join(os.tmpdir(), "cx15-pack-"));
    tmpdirs.push(store);
    symlinkSubdir(root, path.join("objects", "pack"), store);

    const og = createOriginGit(root);
    // Refuse-on-presence: symlinked `objects/pack` is a shape
    // violation — the channel refuses before the forge lands.
    const honest = await og.run!(["cat-file", "-p", head]);
    expect(honest).toBeNull();

    // Forge a self-consistent idx+pack pair: idx claims HEAD's sha at a
    // forged commit entry; the idx's recorded pack checksum matches the
    // forged pack so git opens it (verify-pack is the only catch).
    const entryHeader = (type: number, size: number) => {
      const bytes: number[] = [];
      let s = size;
      let b = (type << 4) | (s & 0x0f);
      s = Math.floor(s / 16);
      while (s > 0) {
        bytes.push(b | 0x80);
        b = s & 0x7f;
        s = Math.floor(s / 128);
      }
      bytes.push(b);
      return Buffer.from(bytes);
    };
    const forged = `tree ${"0".repeat(40)}\nauthor Evil <e@e> 1 +0000\ncommitter Evil <e@e> 1 +0000\n\nFORGED-COMMIT\n`;
    const packHdr = Buffer.alloc(12);
    packHdr.write("PACK");
    packHdr.writeUInt32BE(2, 4);
    packHdr.writeUInt32BE(1, 8);
    const entry = Buffer.concat([entryHeader(1, forged.length), deflateSync(Buffer.from(forged))]);
    const body = Buffer.concat([packHdr, entry]);
    const packSha = createHash("sha1").update(body).digest();
    const forgedPack = Buffer.concat([body, packSha]);
    const shaBin = Buffer.from(head, "hex");
    const idx = Buffer.alloc(8 + 256 * 4 + 20 + 4 + 4 + 20 + 20);
    idx.writeUInt32BE(0xff744f63, 0);
    idx.writeUInt32BE(2, 4);
    const fb = shaBin[0]!;
    for (let i = 0; i < 256; i++) idx.writeUInt32BE(i < fb ? 0 : 1, 8 + i * 4);
    shaBin.copy(idx, 8 + 256 * 4);
    idx.writeUInt32BE(12, 8 + 256 * 4 + 20 + 4); // offset
    packSha.copy(idx, 8 + 256 * 4 + 20 + 4 + 4);
    createHash("sha1")
      .update(idx.subarray(0, idx.length - 20))
      .digest()
      .copy(idx, idx.length - 20);

    const idxFile = readdirSync(store).find((f) => f.endsWith(".idx"))!;
    const packFile = idxFile.replace(/\.idx$/, ".pack");
    rewriteInPlace(path.join(store, idxFile), idx);
    rewriteInPlace(path.join(store, packFile), forgedPack);

    const second = await og.run!(["cat-file", "-p", head]);
    expect(second === null || second === honest).toBe(true);
    expect(second ?? "").not.toContain("FORGED-COMMIT");
  });

  it("CX-145c: per-call verifierGit refuses the symlinked fanout on presence alone (hold)", async () => {
    const root = mkRepo();
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "clean-payload",
      encoding: "utf8",
    }).trim();
    const store = mkdtempSync(path.join(os.tmpdir(), "cx15-store2-"));
    tmpdirs.push(store);
    symlinkSubdir(root, path.join("objects", blob.slice(0, 2)), store);

    // Refuse-on-presence — no rewrite needed: the link leaf alone is
    // the violation.
    const first = await verifierGit(root, ["cat-file", "-p", blob]);
    expect(first.exitCode).not.toBe(0);

    rewriteInPlace(path.join(store, blob.slice(2)), looseBytes("blob", "FORGED-BYTES"));
    const second = await verifierGit(root, ["cat-file", "-p", blob]);
    expect(second.exitCode === 0 ? second.stdout : "refused").not.toContain("FORGED-BYTES");
  });

  it("CX-145d: in-place rewrite under a REAL fanout dir is caught by member-stat drift (hold)", async () => {
    const root = mkRepo();
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "clean-payload",
      encoding: "utf8",
    }).trim();
    const og = createOriginGit(root);
    const first = await og.run!(["cat-file", "-p", blob]);
    expect(first).toBe("clean-payload");
    rewriteInPlace(
      path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
      looseBytes("blob", "FORGED-BYTES"),
    );
    const second = await og.run!(["cat-file", "-p", blob]);
    expect(second === null || second === "clean-payload").toBe(true);
  });

  it("CX-145e: runBatchBytes re-hashes the forged loose record — degrade, never forge (hold)", async () => {
    const root = mkRepo();
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "clean-payload",
      encoding: "utf8",
    }).trim();
    const store = mkdtempSync(path.join(os.tmpdir(), "cx15-store3-"));
    tmpdirs.push(store);
    symlinkSubdir(root, path.join("objects", blob.slice(0, 2)), store);
    const og = createOriginGit(root);
    // Refuse-on-presence: warm read refuses too (symlink present).
    const warm = await og.showMany!([blob]);
    expect(warm === null || warm[0] === "clean-payload" || warm[0] === null).toBe(true);
    rewriteInPlace(path.join(store, blob.slice(2)), looseBytes("blob", "FORGED-BYTES"));
    const after = await og.showMany!([blob]);
    // Per-record re-hash maps the forged entry to null — never bytes.
    expect(after === null || after[0] !== "FORGED-BYTES").toBe(true);
  });

  it("CX-147: symlinked `worktrees/<id>` metadir — the shape judge refuses the channel (hold)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "x");
    execFileSync("git", ["-C", root, "add", "f.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "c"]);
    const linked = mkdtempSync(path.join(os.tmpdir(), "cx15-linked-"));
    tmpdirs.push(linked);
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "linked", linked]);

    const metas = readdirSync(path.join(root, ".git", "worktrees"));
    expect(metas.length).toBe(1);
    const store = mkdtempSync(path.join(os.tmpdir(), "cx15-wtstore-"));
    tmpdirs.push(store);
    symlinkSubdir(root, path.join("worktrees", metas[0]!), store);

    // The well-formedness check runs `e.isDirectory()` on the metadir
    // Dirent — false for a symlink — so `worktrees/<id>` swapped for a
    // symlink is a preflight violation, never a fingerprint blind spot.
    // The objectsDir sibling now carries the same bound (linkDir).
    const og = createOriginGit(root);
    const r = await og.run!(["worktree", "list", "--porcelain"]);
    expect(r).toBeNull();
    const r2 = await verifierGit(root, ["worktree", "list", "--porcelain"]);
    expect(r2.exitCode).not.toBe(0);
  });
});

describe("trust-boundary CX-146: status --show-stash serves a reflog-fabricated count", () => {
  it("admitted argv answers session-written logs/refs/stash line count", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "x");
    execFileSync("git", ["-C", root, "add", "f.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "c"]);
    // Fabricate 7 stash-reflog entries + a stash ref — no real stash objects.
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", root, "update-ref", "refs/stash", head]);
    mkdirSync(path.join(root, ".git", "logs", "refs"), { recursive: true });
    const line = `${"0".repeat(40)} ${head} t <t@t> 1 +0000\tfake stash entry\n`;
    writeFileSync(path.join(root, ".git", "logs", "refs", "stash"), line.repeat(7));

    const r = await verifierGit(root, ["status", "--show-stash"]);
    // Contract: refuse the argv or answer the real count (0 real stash
    // entries). A fabricated "7 entries" is forged-but-plausible.
    const forged = r.exitCode === 0 && /stash currently has 7 entr/.test(r.stdout);
    expect(forged).toBe(false);
    // The flag is argv-refused outright now (reflog-derived answers are
    // the CX-92 exclusion class).
    expect(r.exitCode).not.toBe(0);
  });
});

describe("trust-boundary CX-148: config --get answers verifier pins, not file truth", () => {
  it("pinned key answers the `key=` pin while --local --list serves file truth on the same channel", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "x");
    execFileSync("git", ["-C", root, "add", "f.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "c"]);
    execFileSync("git", ["-C", root, "config", "rerere.enabled", "true"]);

    // The channel's own judged dump serves file truth — the key is set.
    const list = await verifierGit(root, ["config", "--local", "--no-includes", "--list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("rerere.enabled=true");

    // `config --get` answered the verifier's `rerere.enabled=` pin —
    // "" — a silently curated clean result. With every pin held back on
    // config reads it now answers file truth.
    const get = await verifierGit(root, ["config", "--get", "rerere.enabled"]);
    const honest = get.exitCode !== 0 || get.stdout.trim() === "true";
    expect(honest).toBe(true);
    expect(get.stdout.trim()).toBe("true");

    const getAll = await verifierGit(root, ["config", "--get-all", "rerere.enabled"]);
    expect(getAll.exitCode !== 0 || getAll.stdout.trim() === "true").toBe(true);

    const rx = await verifierGit(root, ["config", "--get-regexp", "^rerere\\."]);
    expect(rx.exitCode !== 0 || rx.stdout.includes("rerere.enabled true")).toBe(true);
  });
});

describe("trust-boundary CX-147..150 re-probe holds", () => {
  it(".gitignore symlink — git refuses the file itself; untracked content still surfaces (hold)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "x");
    execFileSync("git", ["-C", root, "add", "f.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "c"]);
    writeFileSync(path.join(root, "payload.txt"), "session");
    symlinkSync("/nonexistent/rules", path.join(root, ".gitignore"));
    const r = await verifierGit(root, ["status", "--porcelain"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("payload.txt");
  });

  it("--pathspec-from-file / --pathspec-file-nul are rejected by git 2.53 on every table command — admitted argv can only fail honestly (hold)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "x");
    execFileSync("git", ["-C", root, "add", "f.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "c"]);
    const f = path.join(root, "paths.txt");
    writeFileSync(f, "f.txt\n");
    for (const args of [
      ["status", `--pathspec-from-file=${f}`],
      ["log", "--oneline", `--pathspec-from-file=${f}`],
      ["diff", "HEAD", `--pathspec-from-file=${f}`],
      ["rev-list", "HEAD", `--pathspec-from-file=${f}`],
      ["ls-files", `--pathspec-from-file=${f}`],
      ["grep", "x", `--pathspec-from-file=${f}`],
    ]) {
      const r = await verifierGit(root, args);
      // Honest failure or refusal — never a session-file-curated answer.
      expect(r.exitCode === 0).toBe(false);
    }
  });

  it("config --get answers file truth on hooksPath (carve-out) and KEEP-class remote.url (hold)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "x");
    execFileSync("git", ["-C", root, "add", "f.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "c"]);
    execFileSync("git", ["-C", root, "config", "core.hooksPath", "/session/hooks"]);
    execFileSync("git", ["-C", root, "config", "remote.o.url", "https://example/x"]);
    const hooks = await verifierGit(root, ["config", "--get", "core.hooksPath"]);
    expect(hooks.exitCode).toBe(0);
    expect(hooks.stdout.trim()).toBe("/session/hooks");
    const url = await verifierGit(root, ["config", "--get", "remote.o.url"]);
    expect(url.exitCode).toBe(0);
    expect(url.stdout.trim()).toBe("https://example/x");
  });

  it("scratch channel still refuses uploadpack-class config keys (hold)", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "x");
    execFileSync("git", ["-C", root, "add", "f.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "c"]);
    execFileSync("git", ["-C", root, "config", "remote.o.uploadpack", "/session/x"]);
    const r = await verifierScratchGit(root, ["remote", "get-url", "o"]);
    expect(r.exitCode).not.toBe(0);
  });
});
