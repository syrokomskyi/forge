/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-11 adversarial verification of
the external-verification trust boundary. Every probe FAILS while its
counterexample is live and PASSES once closed; numbering continues from
CX-124 (round 10 reported CX-123/CX-124 + controls).

Round-11 attack surfaces (assumptions the r10 remediation left open):

  - `.git/info/attributes` is session-writable metadata that is NOT among
    EVIDENCE_SHAPE_QUERY_PATHS — the r6 exemption reasoned "driver commands
    are neutralized by the diff/filter pins, so the file can no longer reach
    a program". But git applies BUILT-IN conversions that reach no program:
    `working-tree-encoding`, `text`/`eol`/`crlf`, `ident`. A session-set
    `working-tree-encoding` makes status/diff content-hash the worktree
    bytes through iconv — a UTF-16LE-encoded worktree file hashes to the
    committed ASCII blob, so every trusted status/diff/describe verdict
    reports CLEAN on completely different raw bytes (CX-125).
  - `isUnprovenIndexRead` counts "revs" as non-option tokens before `--`.
    `git diff <rev> <existing-nonrev-path>` (no `--`) is a WORKTREE diff —
    diff-index consults the ambient index stat cache — but the path token
    counts as a second "rev", so the shape is classified tree-to-tree and
    allowed (CX-126).
  - `describe` is absent from INDEX_CONSULTING_OPS entirely — `describe
    --dirty` runs the same diff-index stat-cache machinery as status, so a
    forged index answers a clean verdict (no -dirty suffix) on dirty bytes
    (CX-127).
  - `isUnprovenIndexRead`'s grep branch treats the last pre-`--` token as a
    rev. `git grep <pattern> -- <path>` is a WORKTREE grep (the "rev" is
    really the pattern), classified tree-anchored — and a session-set
    `skip-worktree` index flag hides the file from the enumeration the
    ambient index drives (CX-128).
  - The verifier-owned claims-rebuilt index lives under
    `os.tmpdir()/forge-evidence-idx-*` — session-writable space (the same
    plantable-temp-root class CX-123 was closed for). `createOriginGit`
    CACHES its preflight (and its `indexEnv`) for the instance lifetime,
    so a same-uid session can `readdir` the temp root, find `index-N`, and
    overwrite it with a fully forged index AT LEISURE — every subsequent
    trusted index-consulting read answers the forgery (CX-129).
  - `runBatchBytes` feeds `specs.join("\n")` to `cat-file --batch` unsanitized.
    A spec containing `\n` splits into two stdin queries, git answers one
    record per LINE, and `parseCatFileBatchBytes` consumes one record per
    ARRAY ENTRY — every subsequent spec is answered with the wrong object's
    bytes (a self-consistent record that re-hashes clean but is attributed
    to a different file). Reachable: `audit/snapshot.ts` builds
    `<sha>:<path>` specs from `ls-tree -r -z` output — committed paths may
    contain `\n`, and `isAuditRelevant` still matches `.ts` etc. (CX-130).
  - `remote.<name>.url` and `url.<base>.insteadOf` are KEEP-classed — the
    transport TARGET of the trusted `ls-remote`/`fetch` is session config.
    `protocol.file.allow` is unpinned (`user` default allows top-level file:
    transports), so `ls-remote origin` and the pinned `fetch origin
    +refs/heads/*:refs/remotes/origin/*` read refs from a session repo — the
    digest's remoteTips and the push scan's remote-tracking view are forged
    (CX-131). The code comment claims literal-remote immunity (CX-50); the
    KEEP table does not deliver it.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the boundary implementation owns behaviour.</item>
  <item>The probabilistic same-uid race against verifierGit/gitEvidence
    per-call index files (a microtask-wide window); the OriginGit cache
    exposes the same root cause deterministically, and is the probe.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifierGit } from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const gitIn = (root: string, args: string[], input?: string | Buffer) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input,
  });

function repo(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(root);
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "t@t"]);
  gitIn(root, ["config", "user.name", "t"]);
  gitIn(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

/**
 * Hand-write `.git/index` with ONE entry carrying the worktree file's live
 * stat tuple but HEAD's blob sha — the CX-121 fabrication primitive: raw
 * `status --porcelain` answers clean while the worktree bytes differ.
 */
function forgeIndexEntry(root: string, file: string): void {
  const st = statSync(path.join(root, file), { bigint: true });
  const headBlob = gitIn(root, ["rev-parse", `HEAD:${file}`]).trim();
  const name = Buffer.from(file);
  const entry = Buffer.alloc(40);
  const wr = (v: bigint | number, o: number) =>
    entry.writeUInt32BE(Number(BigInt(v) & 0xffffffffn), o);
  wr(st.ctimeNs / 1_000_000_000n, 0);
  wr(st.ctimeNs % 1_000_000_000n, 4);
  wr(st.mtimeNs / 1_000_000_000n, 8);
  wr(st.mtimeNs % 1_000_000_000n, 12);
  wr(st.dev, 16);
  wr(st.ino, 20);
  wr(0o100644, 24);
  wr(st.uid, 28);
  wr(st.gid, 32);
  wr(st.size, 36);
  const full = Buffer.concat([
    entry,
    Buffer.from(headBlob, "hex"),
    Buffer.from([0, name.length]),
    name,
  ]);
  const pad = Buffer.alloc((8 - (full.length % 8)) % 8);
  const idxBody = Buffer.concat([
    Buffer.from("DIRC"),
    Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]),
    full,
    pad,
  ]);
  writeFileSync(
    path.join(root, ".git/index"),
    Buffer.concat([idxBody, createHash("sha1").update(idxBody).digest()]),
  );
  // mtime ordering: index newer than the file entry → not racily clean.
  utimesSync(path.join(root, ".git/index"), new Date(), new Date());
}

/** Dirty a tracked file the CX-121 way and plant the forged-clean index. */
function forgeCleanIndex(root: string, file: string): void {
  writeFileSync(path.join(root, file), "evil\n");
  const past = new Date(Date.now() - 60_000);
  utimesSync(path.join(root, file), past, past);
  forgeIndexEntry(root, file);
}

/** The newest `index-*` file inside any `forge-evidence-idx-*` temp dir. */
function newestIdxFile(): string | null {
  let best: string | null = null;
  let bestT = -1;
  for (const d of readdirSync(os.tmpdir()).filter((x) => x.startsWith("forge-evidence-idx-"))) {
    for (const f of readdirSync(path.join(os.tmpdir(), d)).filter((x) => x.startsWith("index-"))) {
      const p = path.join(os.tmpdir(), d, f);
      const t = statSync(p).mtimeMs;
      if (t > bestT) {
        bestT = t;
        best = p;
      }
    }
  }
  return best;
}

/**
 * Force the claims-index rebuild into the unproven branch: `.git/index`
 * is session-writable too, so garbage bytes make `ls-files --stage` die
 * (`index file corrupt`), `prepareEvidenceIndex` fails, and every
 * index-consulting read must refuse. (The verifier's own index carries
 * no session-reachable path — the r11 sabotage primitive of chmod'ing a
 * discoverable `forge-evidence-idx-*` dir no longer applies.)
 */
function corruptIndex(root: string): void {
  writeFileSync(path.join(root, ".git", "index"), "garbage-not-an-index");
}

// ===========================================================================
// CX-125 — `.git/info/attributes` built-in conversions hide dirty bytes
// ===========================================================================

describe("RFC-1616 r11 — session .git/info/attributes rewrites what trusted status/diff hash", () => {
  it(
    "CX-125: a session-written `.git/info/attributes` `working-tree-encoding` makes the rebuilt-index content-hash equal the committed blob on completely different worktree bytes — trusted status/diff/describe answer CLEAN on all three channels (no index failure needed)",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx11-attr-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      mkdirSync(path.join(root, ".git/info"), { recursive: true });
      // Session-writable, uncommitted, unjudged — not a shape path.
      writeFileSync(
        path.join(root, ".git/info/attributes"),
        "a.txt working-tree-encoding=UTF-16LE\n",
      );
      // Worktree bytes are the UTF-16LE transcription of the committed blob —
      // completely different bytes, hashing equal after git's clean-side
      // conversion.
      writeFileSync(path.join(root, "a.txt"), Buffer.from("good\n", "utf16le"));

      // Premise: a zeroed-stat (verifier-style) index makes raw git report
      // clean — the transcode path runs inside the content hash. The zero
      // index lives OUTSIDE the repo so it adds no untracked noise.
      const claims = gitIn(root, ["ls-files", "--stage", "-z"]);
      const zeroIdx = path.join(path.dirname(root), ".zero-idx");
      execFileSync("git", ["update-index", "-z", "--index-info"], {
        cwd: root,
        env: { ...process.env, GIT_INDEX_FILE: zeroIdx },
        input: claims,
      });
      const rawStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: root,
        env: { ...process.env, GIT_INDEX_FILE: zeroIdx },
        encoding: "utf8",
      });
      expect(
        rawStatus,
        `premise: the zero-stat rebuild + info/attributes must show raw git clean (got ${JSON.stringify(rawStatus)})`,
      ).toBe("");

      const s = await gitEvidence(root, ["status", "--porcelain"]);
      expect(
        s.exitCode !== 0 || s.stdout.trim().length > 0,
        `gitEvidence status answered clean on foreign-encoded bytes (exit=${s.exitCode}, out=${JSON.stringify(s.stdout)}, err=${JSON.stringify(s.stderr.slice(0, 120))})`,
      ).toBe(true);
      const v = await verifierGit(root, ["status", "--porcelain"]);
      expect(
        v.exitCode !== 0 || v.stdout.trim().length > 0,
        `verifierGit status answered clean on foreign-encoded bytes (exit=${v.exitCode}, out=${JSON.stringify(v.stdout)})`,
      ).toBe(true);
      const og = await createOriginGit(root).run(["status", "--porcelain"]);
      expect(
        og === null || og.trim().length > 0,
        `origin channel status answered clean on foreign-encoded bytes (${JSON.stringify(og)})`,
      ).toBe(true);
      const d = await gitEvidence(root, ["diff", "HEAD", "--", "a.txt"]);
      expect(
        d.exitCode !== 0 || d.stdout.trim().length > 0,
        `gitEvidence diff answered clean on foreign-encoded bytes (exit=${d.exitCode}, out=${JSON.stringify(d.stdout.slice(0, 80))})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-126/127/128 — isUnprovenIndexRead coverage gaps
// ===========================================================================

describe("RFC-1616 r11 — index-consulting shapes that evade isUnprovenIndexRead", () => {
  it(
    "CX-126: `git diff <rev> <existing-nonrev-path>` (no `--`) is a WORKTREE diff that consults the index stat cache — but the path token counts as a second 'rev', so the shape is classified tree-to-tree and proceeds on the ambient forged index when the rebuild is unproven",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx11-diff-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      forgeCleanIndex(root, "a.txt");

      // Premise: raw git answers the forged-clean verdict for this shape.
      expect(gitIn(root, ["diff", "HEAD", "a.txt"])).toBe("");

      // The session cannot reach the verifier index (nameless O_TMPFILE
      // inode) — but it owns `.git/index`: garbage bytes make the claims
      // enumeration fail, forcing the unproven branch.
      corruptIndex(root);
      // R11-R1..R11-R8 controls: every properly classified
      // index-consulting shape still refuses on the unproven index —
      // bare status/ls-files/diff, single-rev diff, --cached diff,
      // rev+`--`+path diff, bare grep, and `-e`-pattern grep. The
      // CX-126 evasion is exactly the `<rev> <path>` spelling with no
      // separator.
      for (const argv of [
        ["status", "--porcelain"],
        ["ls-files"],
        ["diff"],
        ["diff", "HEAD"],
        ["diff", "--cached"],
        ["diff", "HEAD", "--", "a.txt"],
        ["grep", "needle"],
        ["grep", "-e", "needle", "--", "a.txt"],
      ]) {
        const refused = await gitEvidence(root, argv);
        expect(
          refused.exitCode !== 0 && refused.stderr.includes("EVIDENCE-REFUSED"),
          `control: unproven ${JSON.stringify(argv)} did not refuse (exit=${refused.exitCode})`,
        ).toBe(true);
      }

      const d1 = await gitEvidence(root, ["diff", "HEAD", "a.txt"]);
      expect(
        d1.exitCode !== 0 || d1.stdout.trim().length > 0,
        `gitEvidence diff HEAD a.txt answered the forged-clean verdict (exit=${d1.exitCode}, out=${JSON.stringify(d1.stdout.slice(0, 80))})`,
      ).toBe(true);
      const d2 = await verifierGit(root, ["diff", "HEAD", "a.txt"]);
      expect(
        d2.exitCode !== 0 || d2.stdout.trim().length > 0,
        `verifierGit diff HEAD a.txt answered the forged-clean verdict (exit=${d2.exitCode}, out=${JSON.stringify(d2.stdout.slice(0, 80))})`,
      ).toBe(true);
      const ogd = await createOriginGit(root).run(["diff", "HEAD", "a.txt"]);
      expect(
        ogd === null || ogd.trim().length > 0,
        `origin channel diff HEAD a.txt answered the forged-clean verdict (${JSON.stringify(ogd)})`,
      ).toBe(true);
    },
  );

  it(
    "CX-127: `describe --dirty` is not index-classified at all — a forged-clean index answers the clean verdict (no -dirty suffix) on dirty bytes when the rebuild is unproven",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx11-desc-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      forgeCleanIndex(root, "a.txt");

      // Premise: raw describe --dirty answers clean on the forged index.
      expect(gitIn(root, ["describe", "--always", "--dirty"]).trim()).not.toContain("dirty");

      corruptIndex(root);
      const d = await verifierGit(root, ["describe", "--always", "--dirty"]);
      expect(
        d.exitCode !== 0 || d.stdout.includes("dirty"),
        `verifierGit describe --dirty answered the forged-clean verdict (exit=${d.exitCode}, out=${JSON.stringify(d.stdout)})`,
      ).toBe(true);
      const e = await gitEvidence(root, ["describe", "--always", "--dirty"]);
      expect(
        e.exitCode !== 0 || e.stdout.includes("dirty"),
        `gitEvidence describe --dirty answered the forged-clean verdict (exit=${e.exitCode}, out=${JSON.stringify(e.stdout)})`,
      ).toBe(true);
      const og = await createOriginGit(root).run(["describe", "--always", "--dirty"]);
      expect(
        og === null || og.includes("dirty"),
        `origin channel describe --dirty answered the forged-clean verdict (${JSON.stringify(og)})`,
      ).toBe(true);
    },
  );

  it(
    "CX-128: `git grep <pattern> -- <path>` is a WORKTREE grep — the 'rev' the classifier checks is really the pattern — and a session-set `skip-worktree` flag in the ambient index hides the file from the enumeration the read consults when the rebuild is unproven",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx11-grep-");
      writeFileSync(path.join(root, "a.txt"), "needle\n");
      writeFileSync(path.join(root, "b.txt"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      // Session flag — ordinary `update-index --skip-worktree` writes it
      // into .git/index; the claims rebuild can never carry flags.
      gitIn(root, ["update-index", "--skip-worktree", "a.txt"]);

      // Premise: the ambient index flag hides the file from raw worktree grep.
      let rawMissed = false;
      try {
        gitIn(root, ["grep", "-l", "needle", "--", "a.txt"]);
      } catch {
        rawMissed = true;
      }
      expect(rawMissed, "premise: skip-worktree must hide the file from raw grep").toBe(true);

      corruptIndex(root);
      const g = await gitEvidence(root, ["grep", "-l", "needle", "--", "a.txt"]);
      expect(
        !(g.exitCode === 1 && g.stdout === ""),
        `gitEvidence grep answered 'no match' on a file containing the pattern (exit=${g.exitCode}, out=${JSON.stringify(g.stdout)})`,
      ).toBe(true);
      const v = await verifierGit(root, ["grep", "-l", "needle", "--", "a.txt"]);
      expect(
        !(v.exitCode === 1 && v.stdout === ""),
        `verifierGit grep answered 'no match' on a file containing the pattern (exit=${v.exitCode}, out=${JSON.stringify(v.stdout)})`,
      ).toBe(true);
      const og = await createOriginGit(root).runExit?.(["grep", "-l", "needle", "--", "a.txt"]);
      expect(
        !(og !== null && og !== undefined && og.code === 1 && og.stdout === ""),
        `origin channel grep answered 'no match' on a file containing the pattern (${JSON.stringify(og)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-129 — the verifier-owned index lives in session-writable temp space
// ===========================================================================

describe("RFC-1616 r11 — the claims-rebuilt index is rewritable by the session", () => {
  it(
    "CX-129: `forge-evidence-idx-*` under os.tmpdir() is discoverable + writable by a same-uid session — OriginGit caches its preflight (with indexEnv) for the instance lifetime, so a session overwrites `index-N` with a fully forged index AT LEISURE and the next trusted status answers clean on dirty bytes",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx11-idxw-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      forgeCleanIndex(root, "a.txt");

      const og = createOriginGit(root);
      const first = await og.run(["status", "--porcelain", "--untracked-files=no"]);
      expect(
        typeof first === "string" && first.includes("M"),
        `control: the honest rebuilt index must report the dirt (${JSON.stringify(first)})`,
      ).toBe(true);

      // The session discovers the verifier-owned index file by polling the
      // OS temp root and overwrites it with the ambient forged index —
      // no race needed, the file persists for the process lifetime.
      // (Closed state: the fd-held index has no path at all, so
      // `newestIdxFile()` finds nothing to overwrite; the no-/dev/fd
      // fallback re-proves the on-disk bytes before every spawn, so an
      // overwritten file flips the read to unproven-null, never to the
      // forgery.)
      const idx = newestIdxFile();
      if (idx !== null) copyFileSync(path.join(root, ".git/index"), idx);

      const second = await og.run(["status", "--porcelain", "--untracked-files=no"]);
      expect(
        second === null || (typeof second === "string" && second.includes("M")),
        `the session-rewritten verifier index answered the forged-clean verdict (${JSON.stringify(second)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-130 — cat-file --batch spec newline desyncs record↔spec attribution
// ===========================================================================

describe("RFC-1616 r11 — batch spec lines are unsanitized", () => {
  it(
    "CX-130: a `showMany` spec containing `\\n` splits into two stdin queries — git answers one record per LINE while the parser consumes one per ARRAY ENTRY, so every subsequent spec is answered with the wrong object's bytes (reachable: `ls-tree -r -z` paths → `audit/snapshot.ts` `<sha>:<path>` specs — committed paths may contain \\n)",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx11-batch-");
      writeFileSync(path.join(root, "a.ts"), "CONTENT-A\n");
      writeFileSync(path.join(root, "b.ts"), "CONTENT-B\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      const sha = gitIn(root, ["rev-parse", "HEAD"]).trim();
      const og = createOriginGit(root);
      // specs[0] embeds a newline (as a committed newline-path would produce):
      // stdin becomes three queries for two specs → result[1] is CONTENT-B
      // attributed to `${sha}:a.ts`.
      const res = await og.showMany?.([`${sha}:a.ts\n${sha}:b.ts`, `${sha}:a.ts`]);
      expect(res).not.toBeNull();
      expect(res![1], `spec desync attributed the wrong object's bytes to ${sha}:a.ts`).toBe(
        "CONTENT-A\n",
      );
    },
  );
});

// ===========================================================================
// CX-131 — KEEP-classed url levers steer trusted transports at session repos
// ===========================================================================

describe("RFC-1616 r11 — session remote/url config steers the trusted ls-remote/fetch", () => {
  it(
    "CX-131: `url.<file>.insteadOf` is KEEP-classed and `protocol.file.allow` is unpinned — trusted `ls-remote origin` and the pinned `fetch origin +refs/heads/*:refs/remotes/origin/*` read refs from a session repo, forging the digest's remoteTips and the push scan's remote-tracking view (the claimed CX-50 literal-remote immunity does not exist for repo config)",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx11-url-");
      writeFileSync(path.join(root, "r.txt"), "real\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "real"]);
      const fake = repo("cx11-fake-");
      writeFileSync(path.join(fake, "f.txt"), "FAKE\n");
      gitIn(fake, ["add", "-A"]);
      gitIn(fake, ["commit", "-qm", "fake"]);
      gitIn(fake, ["tag", "v9.9.9"]);

      gitIn(root, ["config", "remote.origin.url", "https://real.example/repo.git"]);
      gitIn(root, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      // The session rewrites the trusted remote target to its own repo —
      // a KEEP-classed config value the preflight does not judge.
      gitIn(root, ["config", `url.file://${fake}.insteadOf`, "https://real.example/repo.git"]);

      const r = await gitEvidence(root, ["ls-remote", "--tags", "origin"]);
      expect(
        !(r.exitCode === 0 && r.stdout.includes("v9.9.9")),
        `trusted ls-remote answered the session repo's tag list via url.insteadOf (exit=${r.exitCode}, out=${JSON.stringify(r.stdout)})`,
      ).toBe(true);

      const f = await gitEvidence(root, [
        "fetch",
        "--prune",
        "--no-tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      const refs = await gitEvidence(root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin",
      ]);
      expect(
        !(f.exitCode === 0 && refs.stdout.includes("refs/remotes/origin/")),
        `trusted fetch populated remote-tracking refs from the session repo (fetch exit=${f.exitCode}, refs=${JSON.stringify(refs.stdout)})`,
      ).toBe(true);
    },
  );
});
