/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-10 adversarial verification of
the external-verification trust boundary. Every probe FAILS while its
counterexample is live and PASSES once closed; numbering continues from
CX-122 (round 9 reported CX-113..CX-122 + six holds).

Round-10 attack surfaces (assumptions the r9 remediation left open):
  - The `core.hooksPath` pin target (`evidenceHooksDir`) was a mkdtemp dir
    created ONCE per process and reused for the process lifetime — a
    concurrent session (same uid, the boundary's own threat model) could
    discover it by polling the OS temp dir AFTER creation and plant an
    executable hook file into it at leisure (CX-123). CLOSED: the pin now
    aims at the null device — no verifier hooks dir exists, a char device
    has no plantable entries, and the ENOTDIR hook stat skips every hook.
  - `prepareEvidenceIndex` returned `{}` (no `GIT_INDEX_FILE`) whenever its
    `update-index --index-info` rebuild failed — routing index-consulting
    reads at the AMBIENT session index, which can be a perfectly valid
    CX-121 forged-stat index answering CLEAN on dirty bytes (CX-124).
    CLOSED: a failed enumeration/rebuild is now a preflight shape
    violation — every index-consulting trusted read refuses outright
    (EVIDENCE-REFUSED / null) instead of consulting the ambient index.
  - The pack-integrity memo is keyed on the `.idx` stat triple only — the
    `.pack` sibling is never stat'd. A `.pack` rewrite after an honest
    `verify-pack -s` would be invisible to the memo, BUT git itself binds
    the pair: the idx trailer records the pack's sha1 and every object
    read refuses a pack whose trailer does not match ("packfile does not
    match index"). The TOCTOU is defended by git, not by the memo —
    recorded as a control (R10-R2), not a counterexample.
  - Freshly forged pack+idx pairs still refuse (verify-pack -s validates
    object names — R10-R1), the argv table still refuses abbreviated
    forbidden flags and the ext transport, the heredoc lexer stays
    quote-aware, and ambient GIT_* (including GIT_CONFIG_* injection)
    stays stripped — all re-verified as controls.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the boundary implementation owns behaviour.</item>
  <item>Windows-only path shapes (exportTree backslash traversal), post-export
    mutation of the review export by a concurrent session, and remote-side
    config on the operator's real remote — noted, not probed.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { scaffoldTrustBoundary } from "../../../src/onboarding/trust-boundary.ts";
import { verifierGit } from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";
import { listWorkspaceFiles } from "../workspace.ts";
import { runPolicyDigest } from "../../core/handlers/policy-digest.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CLEAN_PATH = (process.env["PATH"] ?? "")
  .split(path.delimiter)
  .filter((d) => d.length > 0 && !existsSync(path.join(d, "git-wrapper.sh")))
  .join(path.delimiter);
beforeAll(() => {
  process.env["PATH"] = CLEAN_PATH;
});

/**
 * Module-load snapshot of the verifier's own OS-temp hooks state. Any
 * `forge-evidence-hooks-*` dir appearing after this point was created by
 * THIS process — the "session" in CX-123 discovers and plants into exactly
 * those (the concurrent-session attack needs no race: the dir persists for
 * the process lifetime).
 */
const hooksDirsBefore = new Set(
  readdirSync(os.tmpdir()).filter((d) => d.startsWith("forge-evidence-hooks-")),
);

const gitIn = (root: string, args: string[], input?: string | Buffer) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input,
  });

/** `gitIn` with the failure captured — for premises where git must refuse. */
const gitInSoft = (root: string, args: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: gitIn(root, args) };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
};

function repo(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(root);
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "t@t"]);
  gitIn(root, ["config", "user.name", "t"]);
  gitIn(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

const digestCtx = (root: string): ForgeRuntimeContext => ({
  workspaceRoot: root,
  logger: { section: () => {}, info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  dryRun: false,
  outputFormat: "json",
  io: ambientIo,
});
const digestInp = (flags: Record<string, unknown>): ForgeCommandInput => ({
  argv: [],
  flags: flags as ForgeCommandInput["flags"],
});

// ─── forged-pack primitives (single object at offset 12) ───────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** git pack object header: (type<<4 | size&15) then 7-bit size groups. */
function packObjHeader(type: number, size: number): Buffer {
  const out = [(type << 4) | (size & 0x0f)];
  size = Math.floor(size / 16);
  while (size) {
    out[out.length - 1]! |= 0x80;
    out.push(size & 0x7f);
    size = Math.floor(size / 128);
  }
  return Buffer.from(out);
}

/**
 * Build a self-consistent single-object pack + v2 idx: object at offset 12,
 * fanout/CRC/offsets/trailer all structurally valid. When `content` does not
 * hash to `sha` the pair is a verbatim forgery git serves by idx name — and
 * `verify-pack -s` refuses it (R10-R1); when it does, the pair is honest and
 * verify-pack passes.
 */
function buildSinglePack(sha: string, type: 1 | 2 | 3 | 4, content: Buffer) {
  const body = Buffer.concat([packObjHeader(type, content.length), deflateSync(content)]);
  let pack = Buffer.concat([Buffer.from("PACK"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), body]);
  const packSha = createHash("sha1").update(pack).digest();
  pack = Buffer.concat([pack, packSha]);
  const first = parseInt(sha.slice(0, 2), 16);
  const fanout = new Array<number>(256).fill(0);
  for (let i = first; i < 256; i++) fanout[i] = 1;
  const u32 = (v: number): Buffer => {
    const u = Buffer.alloc(4);
    u.writeUInt32BE(v);
    return u;
  };
  const idxBody = Buffer.concat([
    Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]),
    Buffer.from(
      fanout.flatMap((n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]),
    ),
    Buffer.from(sha, "hex"),
    u32(crc32(body)),
    u32(12),
    packSha,
  ]);
  const idx = Buffer.concat([idxBody, createHash("sha1").update(idxBody).digest()]);
  return { pack, idx };
}

/** Drop a forged single-object pack+idx pair into `root`'s object store. */
function forgePack(root: string, sha: string, content: Buffer): string {
  const { pack, idx } = buildSinglePack(sha, 3, content);
  const pdir = path.join(root, ".git/objects/pack");
  mkdirSync(pdir, { recursive: true });
  const name = `pack-${createHash("sha1").update(pack).digest("hex").slice(0, 16)}`;
  writeFileSync(path.join(pdir, `${name}.pack`), pack);
  writeFileSync(path.join(pdir, `${name}.idx`), idx);
  return path.join(pdir, `${name}.pack`);
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
  const idx = Buffer.concat([idxBody, createHash("sha1").update(idxBody).digest()]);
  writeFileSync(path.join(root, ".git/index"), idx);
  // mtime ordering: index newer than the file entry → not racily clean.
  utimesSync(path.join(root, ".git/index"), new Date(), new Date());
}

// ─── workflow adoption plumbing (mirrors the r9 file) ──────────────────────

const adoptedWorkflow = (body: string): boolean => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx10-scaffold-"));
  dirs.push(root);
  const rel = ".github/workflows/forge-policy.yml";
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  return scaffoldTrustBoundary(root, "@operator").skipped.some((s) => s.includes(rel));
};

const WORKFLOW_HEAD = `name: forge-policy
on: [push, pull_request]
jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
`;

const workflowWithRun = (run: string): string =>
  `${WORKFLOW_HEAD}      - run: |\n${run
    .split("\n")
    .map((l) => `          ${l}`)
    .join("\n")}\n`;

// ===========================================================================
// CX-123 — the hooks pin target must not be a plantable temp dir
// (closed: core.hooksPath pins at the null device — no verifier hooks dir
// exists, and a char device has no plantable entries)
// ===========================================================================

describe("RFC-1616 r10 — the hooks pin target is dead, not a persistent plantable dir", () => {
  it(
    "CX-123 (closed): trusted spawns create no `forge-evidence-hooks-*` dir under the session-writable OS temp root, and the strongest session lever — repo-config `core.hooksPath` aimed at a planted hook dir — cannot fire a `reference-transaction` inside the pinned fetch because the pin overrides it with the dead path while the fetch itself still succeeds",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx10-hook-");
      // A remote with one commit the local repo lacks, so the pinned fetch
      // performs a real ref update (the transaction the hook fires on).
      const remote = repo("cx10-remote-");
      writeFileSync(path.join(remote, "r.txt"), "remote\n");
      gitIn(remote, ["add", "-A"]);
      gitIn(remote, ["commit", "-qm", "remote commit"]);
      // The remote must ride a transport the session cannot author — a
      // `remote.origin.url` naming a PATH is session-servable and the
      // r11 transport judgment refuses it (CX-131), so the fixture
      // serves the repo over loopback git://.
      const daemonPort = await new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
          const p = (srv.address() as net.AddressInfo).port;
          srv.close(() => resolve(p));
        });
      });
      const daemon = spawn("git", [
        "daemon",
        "--export-all",
        "--reuseaddr",
        `--base-path=${path.dirname(remote)}`,
        "--listen=127.0.0.1",
        `--port=${daemonPort}`,
      ]);
      try {
        for (let i = 0; ; i++) {
          try {
            gitIn(root, ["ls-remote", `git://127.0.0.1:${daemonPort}/${path.basename(remote)}`]);
            break;
          } catch (e) {
            if (i > 50) throw e;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        gitIn(root, [
          "config",
          "remote.origin.url",
          `git://127.0.0.1:${daemonPort}/${path.basename(remote)}`,
        ]);
        gitIn(root, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);

        // Trusted spawns must not materialize a hooks dir the session can
        // discover by polling the temp root and plant hooks into (CX-123).
        const s = await verifierGit(root, ["status", "--porcelain"]);
        expect(s.exitCode).toBe(0);
        const fresh = readdirSync(os.tmpdir()).filter(
          (d) => d.startsWith("forge-evidence-hooks-") && !hooksDirsBefore.has(d),
        );
        expect(
          fresh,
          "the verifier still materializes a plantable hooks dir under the session-owned temp root",
        ).toEqual([]);

        // The session's strongest lever: repo-config `core.hooksPath` aimed
        // at a dir holding an executable reference-transaction hook. The
        // pin must override it with the dead path — the ref update fires
        // nothing — while the fetch itself still succeeds.
        const planted = path.join(root, ".planted-hooks");
        mkdirSync(planted, { recursive: true });
        const marker = path.join(root, ".ref-tx-marker");
        const hook = path.join(planted, "reference-transaction");
        writeFileSync(
          hook,
          `#!/bin/sh\necho HOOK-RAN > ${JSON.stringify(marker).slice(1, -1)}\nexit 0\n`,
        );
        chmodSync(hook, 0o755);
        gitIn(root, ["config", "core.hooksPath", planted]);
        // Control: the repo's own hooks dir carries no such hook — the exec
        // could only have come from the configured path.
        expect(existsSync(path.join(root, ".git/hooks/reference-transaction"))).toBe(false);

        // CX-132: fetch is refused at the argv layer — the configured
        // hooksPath is unreachable through a transport op (the /dev/null
        // pin already covered every spawn; this lever is dead at two
        // layers now).
        const f = await gitEvidence(root, ["fetch", "origin"]);
        expect(f.exitCode !== 0, "the evidence channel ran a transport op").toBe(true);
        expect(
          !existsSync(marker),
          "the session-configured hook executed inside the trusted channel",
        ).toBe(true);
      } finally {
        daemon.kill();
      }
    },
  );
});

// ===========================================================================
// CX-124 — prepareEvidenceIndex must fail CLOSED, never at the ambient index
// (closed: a failed claims rebuild is a preflight shape violation, so every
// index-consulting trusted read refuses outright)
// ===========================================================================

describe("RFC-1616 r10 — the claims-rebuild failure refuses, never falls back to the forged ambient index", () => {
  it(
    "CX-124 (closed): a session-corrupted `.git/index` makes every claims rebuild fail (the verifier's own index is a nameless O_TMPFILE inode), and the channels now REFUSE the read (EVIDENCE-REFUSED / null) instead of consulting the ambient session-writable `.git/index` — a hand-written CX-121 stat-forged index can no longer answer clean on dirty bytes; the healthy-path control still reports the dirt",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx10-idx-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      // Same-size dirty edit so every stat field still matches.
      writeFileSync(path.join(root, "a.txt"), "evil\n");
      // Racy-clean defeat: the file's mtime must be strictly OLDER than the
      // .git/index write that follows.
      const past = new Date(Date.now() - 60_000);
      utimesSync(path.join(root, "a.txt"), past, past);
      forgeIndexEntry(root, "a.txt");

      // Premise: raw git answers clean while the worktree byte differs.
      expect(gitIn(root, ["status", "--porcelain"])).toBe("");
      expect(gitIn(root, ["show", "HEAD:a.txt"])).not.toBe(
        readFileSync(path.join(root, "a.txt"), "utf8"),
      );

      // Control: with the rebuild intact the channel content-hashes and
      // reports the dirt (CX-121 stays closed on the healthy path).
      const honest = await gitEvidence(root, ["status", "--porcelain"]);
      expect(
        honest.exitCode === 0 && honest.stdout.includes("M"),
        `control: the rebuilt claims index must show the dirt (exit=${honest.exitCode}, out=${JSON.stringify(honest.stdout)})`,
      ).toBe(true);

      // Sabotage: the verifier index is a nameless O_TMPFILE inode the
      // session cannot discover or chmod — but `.git/index` is
      // session-writable too. Garbage bytes make the claims enumeration
      // (`git ls-files --stage`) die with `index file corrupt`, the
      // rebuild fails, and the channels must FAIL CLOSED: refuse the
      // read (EVIDENCE-REFUSED / null) — never consult the ambient
      // forged index.
      writeFileSync(path.join(root, ".git", "index"), "garbage-not-an-index");
      const ev = await gitEvidence(root, ["status", "--porcelain"]);
      expect(
        ev.exitCode !== 0 && ev.stderr.includes("EVIDENCE-REFUSED"),
        `the sabotaged rebuild did not refuse the evidence read (exit=${ev.exitCode}, out=${JSON.stringify(ev.stdout)})`,
      ).toBe(true);
      const og = await createOriginGit(root).run(["status", "--porcelain", "--untracked-files=no"]);
      expect(
        og === null,
        `the sabotaged rebuild let the origin channel answer from the ambient forged index (${JSON.stringify(og)})`,
      ).toBe(true);
      // The degradation is scoped: reads that never consult the index
      // still answer — only index-consulting ops refuse (CX-124's rule).
      const rev = await gitEvidence(root, ["rev-parse", "HEAD"]);
      expect(
        rev.exitCode === 0 && rev.stdout.trim().length > 0,
        `a non-index read was refused under the unproven index (exit=${rev.exitCode})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// R10 controls — prior-round remediations re-verified live
// ===========================================================================

describe("RFC-1616 r10 — prior-round controls re-verified", () => {
  it(
    "R10-R1: a FRESHLY forged pack+idx pair (cold memo) still refuses the evidence channel — verify-pack -s validates object names, so the CX-113 anchor holds",
    { timeout: 90_000 },
    async () => {
      const root = repo("cx10-pack-");
      writeFileSync(path.join(root, "a.txt"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      const BF = `deadbee${"3".repeat(33)}`;
      forgePack(root, BF, Buffer.from("FORGED-POLICY-BYTES\n"));
      // Premise: raw git serves the forged bytes for the fabricated sha.
      expect(gitIn(root, ["cat-file", "-p", BF])).toBe("FORGED-POLICY-BYTES\n");
      const r = await gitEvidence(root, ["cat-file", "-p", BF]);
      expect(
        r.exitCode !== 0 && r.stderr.startsWith("EVIDENCE-REFUSED"),
        `a fresh forged pack was not refused (exit=${r.exitCode}, out=${JSON.stringify(r.stdout.slice(0, 40))})`,
      ).toBe(true);
    },
  );

  it(
    "R10-R2: the pack-memo TOCTOU is defended by git itself — an honestly verified pack whose .pack sibling is rewritten in place cannot serve forged bytes, because the idx trailer records the pack sha1 and every object read refuses the mismatched pair (the memo keys the .idx only, but the swap dies in git before any read answers)",
    { timeout: 90_000 },
    async () => {
      const root = repo("cx10-swap-");
      writeFileSync(path.join(root, "policy.txt"), "placeholder\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      const REAL = "real policy content\n";
      const FORGED = "FORGED policy content\n";
      // An honest single-object pack built by git itself.
      const S = gitIn(root, ["hash-object", "-w", "--stdin", "-t", "blob"], REAL).trim();
      const packBytes = execFileSync("git", ["pack-objects", "--stdout"], {
        cwd: root,
        input: `${S}\n`,
        maxBuffer: 16 * 1024 * 1024,
      });
      const pdir = path.join(root, ".git/objects/pack");
      mkdirSync(pdir, { recursive: true });
      const packPath = path.join(pdir, "pack-honest.pack");
      writeFileSync(packPath, packBytes);
      execFileSync("git", ["index-pack", packPath], { cwd: root });
      rmSync(path.join(root, ".git/objects", S.slice(0, 2), S.slice(2)));
      // First read — preflight verify-packs the honest pair, memoizes.
      const first = await gitEvidence(root, ["cat-file", "-p", S]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toBe(REAL);
      // Rewrite the .pack in place (idx untouched — the memo tuple matches).
      const forged = buildSinglePack(S, 3, Buffer.from(FORGED));
      writeFileSync(packPath, forged.pack);
      // Premise: git itself refuses the swapped pair on a raw read.
      const raw = gitInSoft(root, ["cat-file", "-p", S]);
      expect(raw.ok, "premise: git's idx↔pack sha1 binding refuses the swapped pack").toBe(false);
      // The trusted channel fails closed — never serves the forgery.
      const second = await gitEvidence(root, ["cat-file", "-p", S]);
      expect(
        second.exitCode !== 0 || second.stdout !== FORGED,
        `a pack swap after verification served forged bytes (exit=${second.exitCode}, out=${JSON.stringify(second.stdout.slice(0, 40))})`,
      ).toBe(true);
    },
  );

  it(
    "R10-R3: `reflog`/`stash`/caller `-c`/`--git-dir`/config writes/update-ref stay refused on the verifier channel (CX-108/109 hold)",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx10-argv-");
      writeFileSync(path.join(root, "a"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      for (const argv of [
        ["reflog"],
        ["stash", "list"],
        ["-c", "x=y", "status"],
        ["--git-dir", root, "status"],
        ["config", "core.evil", "x"],
        ["update-ref", "refs/heads/master", "HEAD"],
      ]) {
        const r = await verifierGit(root, argv);
        expect(
          r.exitCode !== 0 && r.stderr.includes("EVIDENCE-REFUSED"),
          `${JSON.stringify(argv)} slipped the argv table (exit=${r.exitCode})`,
        ).toBe(true);
      }
    },
  );

  it(
    "R10-R4: abbreviated forbidden flags and the ext transport stay refused — `--out=` (abbrev of --output), `--ext` (abbrev of --ext-diff), `--reflog=`, `--batch-check`, `-u` on ls-remote, `--open-files-in-pager`, and `ext::` transport (protocol.ext.allow=never pin)",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx10-abbrev-");
      writeFileSync(path.join(root, "a"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      const marker = path.join(root, ".ext-marker");
      for (const argv of [
        ["log", "--out=/tmp/cx10-out.txt"],
        ["log", "--ext"],
        ["show", "--output=/tmp/cx10-out2.txt"],
        ["rev-list", "--reflog=all"],
        ["cat-file", "--batch-check"],
        ["ls-remote", "-u", "x"],
        ["grep", "--open-files-in-pager"],
      ]) {
        const r = await verifierGit(root, argv);
        expect(
          r.exitCode !== 0 && r.stderr.includes("EVIDENCE-REFUSED"),
          `${JSON.stringify(argv)} slipped the argv table (exit=${r.exitCode})`,
        ).toBe(true);
      }
      const ext = await gitEvidence(root, ["ls-remote", `ext::sh -c echo > ${marker}`]);
      expect(ext.exitCode !== 0, "the ext transport rode the pinned spawn").toBe(true);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it(
    "R10-R5: a forged LOOSE object still refuses the evidence channel (CX-104a remediation holds)",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx10-loose-");
      writeFileSync(path.join(root, "a"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      const sha = gitIn(
        root,
        ["hash-object", "-w", "--stdin", "-t", "blob"],
        "real-bytes\n",
      ).trim();
      const obj = path.join(root, ".git/objects", sha.slice(0, 2), sha.slice(2));
      chmodSync(obj, 0o644);
      writeFileSync(obj, deflateSync(Buffer.from("blob 6\0forged")));
      const r = await gitEvidence(root, ["cat-file", "-p", sha]);
      expect(
        r.exitCode !== 0 && r.stderr.startsWith("EVIDENCE-REFUSED"),
        `forged loose object not refused (exit=${r.exitCode}, out=${JSON.stringify(r.stdout.slice(0, 30))})`,
      ).toBe(true);
    },
  );

  it(
    "R10-R6: ambient GIT_INDEX_FILE/GIT_DIR stay stripped from listWorkspaceFiles (CX-122) and ambient GIT_CONFIG_* injection cannot arm core.fsmonitor on the verifier channel",
    { timeout: 90_000 },
    async () => {
      const root = repo("cx10-amb-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      writeFileSync(path.join(root, ".gitignore"), "hidden.md\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      writeFileSync(path.join(root, "hidden.md"), "secret\n");
      const foreign = repo("cx10-foreign-");
      writeFileSync(path.join(foreign, "hidden.md"), "secret\n");
      gitIn(foreign, ["add", "hidden.md"]);

      const baseline = await listWorkspaceFiles(root);
      // CX-142: ignore rules never hide files from the trusted
      // enumeration — `hidden.md` is a worktree file, so it lists.
      expect(baseline.includes("hidden.md")).toBe(true);
      const prevIdx = process.env["GIT_INDEX_FILE"];
      const prevDir = process.env["GIT_DIR"];
      process.env["GIT_INDEX_FILE"] = path.join(foreign, ".git", "index");
      process.env["GIT_DIR"] = path.join(foreign, ".git");
      try {
        const listed = await listWorkspaceFiles(root);
        // The ambient env must not move the answer at all: a leaked
        // GIT_DIR would walk the foreign worktree (losing `a.txt`), a
        // leaked GIT_INDEX_FILE would answer foreign index claims.
        expect(
          listed.sort(),
          `ambient GIT_* redirected the workspace listing (got ${JSON.stringify(listed)})`,
        ).toEqual(baseline.sort());
      } finally {
        if (prevIdx === undefined) delete process.env["GIT_INDEX_FILE"];
        else process.env["GIT_INDEX_FILE"] = prevIdx;
        if (prevDir === undefined) delete process.env["GIT_DIR"];
        else process.env["GIT_DIR"] = prevDir;
      }

      // Ambient GIT_CONFIG_* injection: a session-exported config pair
      // arming core.fsmonitor must be stripped by verifierGitEnv.
      const marker = path.join(root, ".fsm-marker");
      const hook = path.join(root, "fsm.sh");
      writeFileSync(
        hook,
        `#!/bin/sh\necho EXEC-FSMONITOR > ${JSON.stringify(marker).slice(1, -1)}\nexit 0\n`,
      );
      chmodSync(hook, 0o755);
      const prevCount = process.env["GIT_CONFIG_COUNT"];
      const prevKey = process.env["GIT_CONFIG_KEY_0"];
      const prevVal = process.env["GIT_CONFIG_VALUE_0"];
      process.env["GIT_CONFIG_COUNT"] = "1";
      process.env["GIT_CONFIG_KEY_0"] = "core.fsmonitor";
      process.env["GIT_CONFIG_VALUE_0"] = hook;
      try {
        const r = await verifierGit(root, ["status", "--porcelain"]);
        expect(r.exitCode).toBe(0);
        expect(
          !existsSync(marker),
          "ambient GIT_CONFIG_* injection armed core.fsmonitor inside the trusted spawn",
        ).toBe(true);
      } finally {
        if (prevCount === undefined) delete process.env["GIT_CONFIG_COUNT"];
        else process.env["GIT_CONFIG_COUNT"] = prevCount;
        if (prevKey === undefined) delete process.env["GIT_CONFIG_KEY_0"];
        else process.env["GIT_CONFIG_KEY_0"] = prevKey;
        if (prevVal === undefined) delete process.env["GIT_CONFIG_VALUE_0"];
        else process.env["GIT_CONFIG_VALUE_0"] = prevVal;
      }
    },
  );

  it(
    "R10-R7: the heredoc lexer stays quote-aware and bash-faithful — a quoted `<<` arms nothing (CX-119), `<<~EOF`/`<<'E'OF`/`<<$EOF` keep body lines stdin (CX-105/106/107), a real invocation still counts",
    { timeout: 60_000 },
    () => {
      // Quoted `<<` must not arm a fake heredoc that hides a real opener.
      const quoted = workflowWithRun(
        ["echo '<<A x'", "cat <<B", "A", "forge correctness.gate", "B"].join("\n"),
      );
      expect(!adoptedWorkflow(quoted), "a quoted `<<` armed a fake heredoc").toBe(true);
      // r8 grammar trio.
      const t1 = workflowWithRun(
        ["cat <<~EOF", "forge correctness.gate", "EOF", "~EOF"].join("\n"),
      );
      const t2 = workflowWithRun(["cat <<'E'OF", "forge correctness.gate", "EOF"].join("\n"));
      const t3 = workflowWithRun(["cat <<$EOF", "forge correctness.gate", "EOF"].join("\n"));
      for (const [name, body] of [
        ["<<~EOF", t1],
        ["<<'E'OF", t2],
        ["<<$EOF", t3],
      ] as const) {
        expect(!adoptedWorkflow(body), `${name} let dead CI count as adopted`).toBe(true);
      }
      // Positive control: a real invocation still counts.
      const real = workflowWithRun(
        [
          "forge correctness.gate --base HEAD~1",
          "forge policy.digest --verify",
          "forge pinned.validate",
        ].join("\n"),
      );
      expect(adoptedWorkflow(real), "a real invocation must still count").toBe(true);
    },
  );

  it(
    "R10-R8: `policy.digest --verify --base` still refuses dynamic revspecs and a fabricated base blob still fails the anchored verify (CX-103/CX-113 hold end to end)",
    { timeout: 90_000 },
    async () => {
      const root = repo("cx10-digest-");
      writeFileSync(
        path.join(root, "forge.yaml"),
        `schema: forge/config@1\nproject:\n  name: demo\npolicy:\n  mutable: [project]\n  freezeFiles:\n    - "hooks/**"\n`,
      );
      mkdirSync(path.join(root, "hooks"), { recursive: true });
      writeFileSync(path.join(root, "hooks", "pre-commit.sh"), "#!/bin/sh\nexit 0\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      for (const rev of ["HEAD", "master", ":/seed"]) {
        const r = await runPolicyDigest(digestInp({ verify: true, base: rev }), digestCtx(root));
        expect(r.exitCode !== 0, `--base ${rev} was accepted (status=${r.data?.status})`).toBe(
          true,
        );
      }
      // A forged pack serving the base's forge.yaml cannot pass the verify:
      // first assert the honest verify passes on the clean store (base below
      // the tip, surface unchanged since the base commit)…
      writeFileSync(path.join(root, "a.txt"), "advance\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "advance"]);
      await runPolicyDigest(digestInp({ write: true }), digestCtx(root));
      gitIn(root, ["add", ".forge/policy.digest"]);
      gitIn(root, ["commit", "-qm", "digest"]);
      const base = gitIn(root, ["rev-parse", "HEAD~2"]).trim();
      const honest = await runPolicyDigest(digestInp({ verify: true, base }), digestCtx(root));
      expect(
        honest.exitCode === 0,
        `honest verify must pass (violations=${JSON.stringify(honest.data?.violations)})`,
      ).toBe(true);
      // …then drop a fresh forged pack+idx pair and confirm the anchor
      // refuses the channel wholesale (CX-113's remediation holds).
      const BF = `deadbee${"9".repeat(33)}`;
      forgePack(
        root,
        BF,
        Buffer.from(
          `schema: forge/config@1\nproject:\n  name: demo\npolicy:\n  mutable: [project]\n  freezeFiles:\n    - "hooks/**"\n`,
        ),
      );
      const r2 = await gitEvidence(root, ["cat-file", "-p", BF]);
      expect(r2.exitCode !== 0 && r2.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
    },
  );
});
