/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-9 adversarial verification of
the external-verification trust boundary. Every probe FAILS while its
counterexample is live and PASSES once closed; numbering continues from
CX-110 (round 8 reported CX-103..CX-110 + two holds).

Round-9 attack surfaces (assumptions the r8 remediation left open):
  - scanLooseObjects re-hashes only `.git/objects/<fanout>/` files — the
    `objects/pack/` directory is never inspected. A session-crafted
    pack-*.pack / pack-*.idx pair answers `cat-file`/`show`/`ls-tree` with
    arbitrary inflated bytes for ANY sha the committed trees reference —
    the same verbatim-forgery primitive as CX-104a, on the path the loose
    scan cannot see. No git read re-hashes pack payloads (only the
    `cat-file --batch` consumer in verification-origin re-hashes — the
    single `run(["show", …])` consumers do not).
  - The loose-object hash memo is keyed (path, mtimeMs, size) — a rewrite
    that preserves both stat fields is never re-scanned, so bytes verified
    once can be replaced wholesale (mtime precision is beatable by setting
    the memoized timestamp to a whole millisecond first).
  - The raw `execFile(gitEnvForCwd())` channels (verify-workspace run(),
    implement-stamp execGit, rfc-evidence-sync, correctness audit gitGrep)
    carry the scrubbed env but NO `-c` pins and no argv judgment — only
    `createOriginGit`/`verifierGit` calls the surface preflight, and only
    as a gate (non-refused config levers stay live on the origin channel).
    `core.fsmonitor` therefore execs a session program inside
    runRfcImplementStamp's `git status`; `exportTree`'s `spawn("tar")`
    inherits ambient env outright (PATH shim); export-ignore/export-subst
    attributes and `core.quotepath` reshape the "committed candidate"
    export the clean-context verifier receives.
  - `.git/index` is session-writable: an entry carrying the worktree
    file's stat tuple but HEAD's blob sha makes `status`/`diff` report a
    clean tree on dirty bytes — the gate's dirtiness verdict and
    RFC-IMP-04 file-clean check are fabricated.
  - The heredoc lexer arms on `<<` inside quoted strings (raw-line scan,
    no quote context). A fake arm hides a REAL opener's lines as body —
    a quoted `'<<A'` arm + `cat <<B` + `A` terminator + gate lines inside
    B's real body → the judge counts invocations bash feeds to cat →
    dead CI adopted (the CX-90 direction, new vector).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the boundary implementation owns behaviour.</item>
  <item>Remote-side config on the operator's real remote, real-network MITM, /etc files — noted, not probed.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { buildManifestReviewWorkspace } from "../../rfc/verify-workspace.ts";
import {
  evaluateEvidenceReuse,
  readCommittedEnvelope,
} from "../../rfc/handlers/rfc-evidence-sync.ts";
import { readAcceptanceReports, runRfcImplementStamp } from "../../rfc/handlers/implement-stamp.ts";
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

const POLICY_YAML = `schema: forge/config@1
project:
  name: demo
paths:
  rfcsDir: docs/rfcs
policy:
  mutable: [project]
  additive: [bindings]
  freezeFiles:
    - "hooks/**"
agentTools:
  deny: [deploy]
`;

function policyRepo(): string {
  const root = repo("cx9-policy-");
  writeFileSync(path.join(root, "forge.yaml"), POLICY_YAML);
  mkdirSync(path.join(root, "hooks"), { recursive: true });
  writeFileSync(path.join(root, "hooks", "pre-commit.sh"), "#!/bin/sh\nexit 0\n");
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-qm", "seed"]);
  return root;
}

// ─── pack forgery primitives ───────────────────────────────────────────────

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
 * Write `.git/objects/pack/pack-<n>.{pack,idx}` carrying `entries`
 * (sha → {type, content}) — git serves these bytes by sha on every read
 * path with no re-hash, and no boundary surface check looks at packs.
 */
function forgePack(
  root: string,
  entries: Array<{ sha: string; type: 1 | 2 | 3 | 4; content: Buffer }>,
): void {
  const sorted = [...entries].sort((a, b) => (a.sha < b.sha ? -1 : 1));
  const bodies = sorted.map((e) =>
    Buffer.concat([packObjHeader(e.type, e.content.length), deflateSync(e.content)]),
  );
  const offsets = bodies.reduce<number[]>((acc, b, i) => {
    acc.push(i === 0 ? 12 : acc[i - 1]! + bodies[i - 1]!.length);
    return acc;
  }, []);
  let pack = Buffer.concat([
    Buffer.from("PACK"),
    Buffer.from([0, 0, 0, 2, 0, 0, 0, sorted.length]),
    ...bodies,
  ]);
  const packSha = createHash("sha1").update(pack).digest();
  pack = Buffer.concat([pack, packSha]);

  const fanout = new Array<number>(256).fill(0);
  for (const e of sorted)
    for (let i = e.sha ? parseInt(e.sha.slice(0, 2), 16) : 0; i < 256; i++) fanout[i]++;
  const idxBody = Buffer.concat([
    Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]),
    Buffer.from(
      fanout.flatMap((n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]),
    ),
    ...sorted.map((e) => Buffer.from(e.sha, "hex")),
    ...bodies.map((b) => {
      const u = Buffer.alloc(4);
      u.writeUInt32BE(crc32(b));
      return u;
    }),
    ...offsets.map((o) => {
      const u = Buffer.alloc(4);
      u.writeUInt32BE(o);
      return u;
    }),
    packSha,
  ]);
  const idx = Buffer.concat([idxBody, createHash("sha1").update(idxBody).digest()]);

  const pdir = path.join(root, ".git/objects/pack");
  mkdirSync(pdir, { recursive: true });
  const name = `pack-${"f".repeat(8)}${createHash("sha1").update(pack).digest("hex").slice(0, 8)}`;
  writeFileSync(path.join(pdir, `${name}.pack`), pack);
  writeFileSync(path.join(pdir, `${name}.idx`), idx);
}

/** `git mktree --missing` — a tree referencing object names that need not exist. */
function mkTree(root: string, lines: string): string {
  return gitIn(root, ["mktree", "--missing"], lines).trim();
}

// ─── workflow adoption plumbing (mirrors the r8 file) ──────────────────────

const adoptedWorkflow = (body: string): boolean => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx9-scaffold-"));
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
// CX-113 — the pack store is never scanned: forged pack+idx answers every
// committed-object read with session bytes (CX-104a's surviving twin)
// ===========================================================================

describe("RFC-1616 r9 — pack-carried objects are unverified", () => {
  it(
    "CX-113: a session-written pack+idx serves fabricated bytes for a sha only committed trees reference — `show <c>:forge.yaml` on the evidence and origin channels returns forged content, and policy.digest --verify --base <c> skips the attestation trailer check because baseDigest == current sha256",
    { timeout: 120_000 },
    async () => {
      const root = policyRepo();
      const base = gitIn(root, ["rev-parse", "HEAD"]).trim();
      // Advance the policy surface without the attestation trailer (control
      // must fail).
      writeFileSync(
        path.join(root, "forge.yaml"),
        POLICY_YAML.replace("deny: [deploy]", "deny: []"),
      );
      gitIn(root, ["commit", "-qam", "weaken the deny list"]);
      await runPolicyDigest(digestInp({ write: true }), digestCtx(root));
      gitIn(root, ["add", ".forge/policy.digest"]);
      gitIn(root, ["commit", "-qm", "regenerate digest — no trailer"]);
      const head = gitIn(root, ["rev-parse", "HEAD"]).trim();
      const honest = await runPolicyDigest(digestInp({ verify: true, base }), digestCtx(root));
      expect(
        honest.exitCode !== 0,
        "control: unattested advance must still fail against the real base",
      ).toBe(true);

      // Fabricated blob name — a sha nothing contains until the pack does.
      const BF = `deadbee${"f".repeat(33)}`;
      // Fake base: HEAD's tree with forge.yaml pointing at BF — every other
      // surface file keeps its real sha so baseDigest's file list matches.
      const treeLines = gitIn(root, ["ls-tree", "HEAD"])
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => (l.endsWith("\tforge.yaml") ? `100644 blob ${BF}\tforge.yaml` : l))
        .join("\n");
      const tFake = mkTree(root, `${treeLines}\n`);
      const cFake = gitIn(root, ["commit-tree", tFake, "-p", base, "-m", "fake base"]).trim();
      // Rebuild the two tip commits on top of the fake base so it is an
      // ancestor of HEAD.
      const c2 = gitIn(root, ["rev-parse", "HEAD~1"]).trim();
      const c2p = gitIn(root, [
        "commit-tree",
        gitIn(root, ["rev-parse", `${c2}^{tree}`]).trim(),
        "-p",
        cFake,
        "-m",
        "c2",
      ]).trim();
      const c3p = gitIn(root, [
        "commit-tree",
        gitIn(root, ["rev-parse", `${head}^{tree}`]).trim(),
        "-p",
        c2p,
        "-m",
        "c3",
      ]).trim();
      gitIn(root, ["update-ref", "refs/heads/master", c3p]);

      // Without the pack, the fabricated blob is simply missing — the read
      // fails closed (control for the A/B).
      let missing = "";
      try {
        gitIn(root, ["cat-file", "-p", BF]);
      } catch (e) {
        missing = String(e);
      }
      expect(missing.length > 0).toBe(true);
      const unfed = await runPolicyDigest(
        digestInp({ verify: true, base: cFake }),
        digestCtx(root),
      );
      expect(unfed.exitCode !== 0, "control: a dangling blob sha must fail the base read").toBe(
        true,
      );

      // The session drops a pack+idx answering BF with the CURRENT yaml —
      // objects/pack is outside scanLooseObjects' fanout sweep.
      forgePack(root, [
        {
          sha: BF,
          type: 3,
          content: Buffer.from(POLICY_YAML.replace("deny: [deploy]", "deny: []")),
        },
      ]);
      // Premise: raw git serves the pack bytes for the fabricated sha.
      expect(gitIn(root, ["cat-file", "-p", BF])).toBe(
        POLICY_YAML.replace("deny: [deploy]", "deny: []"),
      );
      // The evidence channel and the origin channel serve the same forgery.
      const ev = await gitEvidence(root, ["show", `${cFake}:forge.yaml`]);
      const og = await createOriginGit(root).run(["show", `${cFake}:forge.yaml`]);
      const forged = await runPolicyDigest(
        digestInp({ verify: true, base: cFake }),
        digestCtx(root),
      );
      expect(
        forged.exitCode !== 0 || ev.stdout !== POLICY_YAML.replace("deny: [deploy]", "deny: []"),
        `a forged pack answered the anchored base — verify=${forged.data?.status} ` +
          `violations=${JSON.stringify(forged.data?.violations)} ` +
          `evidence=${JSON.stringify(ev.stdout.slice(0, 60))} origin=${JSON.stringify((og ?? "").slice(0, 60))}`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-114 — same-stat rewrite slips the loose-object hash memo
// ===========================================================================

describe("RFC-1616 r9 — loose-object memo trusts (mtimeMs, size)", () => {
  it(
    "CX-114: rewriting a scanned loose object in place with an equal-size payload and the memoized mtime makes the next evidence read serve the forged bytes — the memo's (path, mtimeMs, size) key is the only integrity check, and both fields are session-forgeable",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx9-memo-");
      const real = Buffer.from("a".repeat(4000));
      const sha = gitIn(root, ["hash-object", "-w", "--stdin", "-t", "blob"], real).trim();
      const objPath = path.join(root, ".git/objects", sha.slice(0, 2), sha.slice(2));
      chmodSync(objPath, 0o644);
      // Pin the memo tuple to a whole millisecond so it is exactly restorable.
      const stamp = new Date(1_700_000_000_000);
      utimesSync(objPath, stamp, stamp);
      const st0 = statSync(objPath);

      // First evidence read — preflight scans, hashes real bytes, memoizes.
      const first = await gitEvidence(root, ["cat-file", "-p", sha]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toBe(real.toString());

      // Forge: any body whose deflated loose-object byte size equals the
      // original — vary the body length; a uniform run makes the search
      // deterministic.
      let forged: Buffer | null = null;
      for (let m = real.length - 2000; m <= real.length + 2000; m++) {
        const body = Buffer.concat([
          Buffer.from("FORGED-BYTES-EVIDENCE\n"),
          Buffer.from("b".repeat(Math.max(0, m - 22))),
        ]).subarray(0, m);
        if (body.length !== m) continue;
        const f = deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]));
        if (f.length === st0.size) {
          forged = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
          break;
        }
      }
      expect(forged, "could not build an equal-size forged payload").not.toBeNull();
      chmodSync(objPath, 0o644);
      writeFileSync(objPath, deflateSync(forged!));
      utimesSync(objPath, stamp, stamp);
      const st1 = statSync(objPath);
      expect(st1.mtimeMs).toBe(st0.mtimeMs);
      expect(st1.size).toBe(st0.size);

      // Second evidence read — the memo matches, so no re-hash runs and
      // git inflates the forged payload verbatim.
      const second = await gitEvidence(root, ["cat-file", "-p", sha]);
      const served = second.stdout;
      const forgedBody = forged!.subarray(forged!.indexOf(0) + 1).toString();
      expect(
        second.exitCode !== 0 || served !== forgedBody,
        `the memo let a same-stat rewrite serve forged bytes (exit=${second.exitCode}, out=${JSON.stringify(served.slice(0, 40))})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-115 — unpinned `core.fsmonitor` execs inside the stamp channel's
// `git status` (execGit carries gitEnvForCwd only — no `-c` pins, no preflight)
// ===========================================================================

describe("RFC-1616 r9 — raw gitEnvForCwd channels honor config programs", () => {
  it(
    "CX-115: `core.fsmonitor=<session program>` executes inside runRfcImplementStamp's `git status --porcelain` — execGit runs with the scrubbed env but no evidenceConfigArgs pins and no evidenceRepoPreflight, so a refused-on-evidence lever fires on the trusted stamp path",
    { timeout: 90_000 },
    async () => {
      const root = repo("cx9-fsm-");
      const marker = path.join(root, ".fsm-marker");
      const hook = path.join(root, "fsm.sh");
      writeFileSync(
        hook,
        `#!/bin/sh\necho EXEC-FSMONITOR > ${JSON.stringify(marker).slice(1, -1)}\nexit 0\n`,
      );
      chmodSync(hook, 0o755);
      gitIn(root, ["config", "core.fsmonitor", hook]);
      // The stamp's own evidence channel would refuse this config — prove it.
      const refused = await verifierGit(root, ["status", "--porcelain"]);
      expect(
        refused.exitCode !== 0,
        "control: the pinned evidence channel must refuse the fsmonitor lever",
      ).toBe(true);
      expect(existsSync(marker)).toBe(false);

      // Minimal stamping fixture: an accepted RFC plus an implementation-
      // shaped commit naming it, so the handler reaches isRfcFileClean.
      mkdirSync(path.join(root, "docs/rfcs"), { recursive: true });
      writeFileSync(
        path.join(root, "docs/rfcs/rfc-9001-poc.md"),
        "---\nid: RFC-9001\ntitle: poc\nstatus: accepted\n---\n\n# RFC-9001\n",
      );
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "implement: RFC-9001 poc"]);
      // `git add`/`git commit` invoke the fsmonitor hook themselves (worktree
      // scan) — the marker they leave is fixture noise, not the stamp's read.
      // Clear it so the assertion isolates git spawns inside the stamp.
      rmSync(marker, { force: true });

      await runRfcImplementStamp(digestInp({ id: "RFC-9001" }), digestCtx(root));
      expect(
        !existsSync(marker),
        "the session's fsmonitor program executed inside the stamp's git status",
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-116/117 — the clean-context export channel: ambient `tar` exec and
// committed `.gitattributes` divergence
// ===========================================================================

describe("RFC-1616 r9 — rfc.verify.workspace export channel", () => {
  const manifestExport = async (root: string, out: string) =>
    buildManifestReviewWorkspace({ workspaceRoot: root, candidateSha: "HEAD", outDir: out });

  it(
    'CX-116: `spawn("tar", ["-x","-f","-"], {cwd: out})` in exportTree carries NO env — the ambient PATH resolves tar, so a session PATH shim executes inside the export and fabricates the extracted candidate tree',
    { timeout: 90_000 },
    async () => {
      const root = repo("cx9-tar-");
      writeFileSync(path.join(root, "a.txt"), "real\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      const shimDir = mkdtempSync(path.join(os.tmpdir(), "cx9-shim-"));
      dirs.push(shimDir);
      const marker = path.join(shimDir, "tar-marker");
      writeFileSync(
        path.join(shimDir, "tar"),
        `#!/bin/sh\necho TAR-SHIM-EXEC > "${marker}"\ncat > /dev/null\necho shim-planted > "${shimDir}/../planted.txt"\nexit 0\n`,
      );
      chmodSync(path.join(shimDir, "tar"), 0o755);

      const out = path.join(root, "..", `cx9-out-${Date.now()}`);
      const prevPath = process.env["PATH"];
      process.env["PATH"] = `${shimDir}${path.delimiter}${prevPath}`;
      let res;
      try {
        res = await manifestExport(root, out);
      } finally {
        process.env["PATH"] = prevPath;
      }
      expect(
        !existsSync(marker),
        `ambient-PATH tar shim executed inside the export (status=${res?.status})`,
      ).toBe(true);
    },
  );

  it(
    "CX-117: committed `.gitattributes` export-ignore/export-subst silently reshape the exported candidate — a tracked file vanishes from the 'export of <sha>' the clean-context verifier reviews, and export-subst bytes differ from committed bytes",
    { timeout: 90_000 },
    async () => {
      const root = repo("cx9-attrs-");
      writeFileSync(path.join(root, "secret.ts"), "export const secret = 1;\n");
      writeFileSync(path.join(root, "x.ts"), "// $Format:%H$\n");
      writeFileSync(
        path.join(root, ".gitattributes"),
        "secret.ts export-ignore\nx.ts export-subst\n",
      );
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "attrs"]);

      const out = path.join(root, "..", `cx9-out-${Date.now()}`);
      const res = await manifestExport(root, out);
      expect(res.status).toBe("pass");
      const committedSecret = gitIn(root, ["show", "HEAD:secret.ts"]);
      const exportedX = existsSync(path.join(out, "x.ts"))
        ? readFileSync(path.join(out, "x.ts"), "utf8")
        : "";
      const committedX = gitIn(root, ["show", "HEAD:x.ts"]);
      expect(
        existsSync(path.join(out, "secret.ts")) && exportedX === committedX,
        `export diverged from committed bytes: secret.ts exported=${existsSync(path.join(out, "secret.ts"))} (committed=${JSON.stringify(committedSecret.slice(0, 30))}), x.ts=${JSON.stringify(exportedX.slice(0, 60))} vs committed ${JSON.stringify(committedX.slice(0, 60))}`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-118 — `.git/objects/info/alternates` is honored on the raw channels:
// the shape-file refusal never reaches execGit/gitEnvForCwd consumers, so a
// foreign object store injects fabricated committed bytes (probed dead end:
// core.quotepath=false cannot split --name-only lines — git C-quotes control
// bytes unconditionally, so the newline-name phantom path is closed)
// ===========================================================================

describe("RFC-1616 r9 — alternates on unpreflighted channels", () => {
  it(
    "CX-118: `.git/objects/info/alternates` (a refused shape violation on every gated channel) is honored on the raw execGit/gitEnvForCwd channels — `git update-index --cacheinfo` stages a tree entry whose blob sha lives only in a session foreign store, and `readAcceptanceReports` parses the forged committed bytes as acceptance evidence",
    { timeout: 90_000 },
    async () => {
      const root = repo("cx9-alt-");
      writeFileSync(path.join(root, "a.txt"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      // Foreign objects dir carrying a fabricated blob under a chosen sha.
      const BF = `deadbee${"2".repeat(33)}`;
      const foreign = mkdtempSync(path.join(os.tmpdir(), "cx9-foreign-objs-"));
      dirs.push(foreign);
      const report = "---\nverdict: pass\nsentinel: ALTERNATES-FORGED-REPORT\n---\n\nbody\n";
      mkdirSync(path.join(foreign, BF.slice(0, 2)), { recursive: true });
      writeFileSync(
        path.join(foreign, BF.slice(0, 2), BF.slice(2)),
        deflateSync(Buffer.concat([Buffer.from(`blob ${report.length}\0`), Buffer.from(report)])),
      );
      // The shape violation the gated channel refuses on.
      mkdirSync(path.join(root, ".git/objects/info"), { recursive: true });
      writeFileSync(path.join(root, ".git/objects/info/alternates"), `${foreign}\n`);
      // Stage a report path whose committed blob is BF — cacheinfo trusts
      // the sha without existence checks.
      const rel = "docs/reviews/acceptance/rfc-9001/fake.md";
      gitIn(root, ["update-index", "--add", "--cacheinfo", `100644,${BF},${rel}`]);
      gitIn(root, ["commit", "-qm", "report"]);
      // Premise: raw git resolves BF through the alternates injection.
      expect(gitIn(root, ["show", `HEAD:${rel}`])).toBe(report);

      // The gated channel refuses the shape violation.
      const gated = await verifierGit(root, ["show", `HEAD:${rel}`]);
      expect(
        gated.exitCode !== 0 && gated.stderr.startsWith("EVIDENCE-REFUSED"),
        "control: the evidence channel must refuse alternates",
      ).toBe(true);

      // The raw stamp channel serves the forged committed bytes anyway.
      const reports = await readAcceptanceReports(root, "RFC-9001");
      const forged = reports.find((r) => r.frontmatter["sentinel"] === "ALTERNATES-FORGED-REPORT");
      expect(
        forged === undefined,
        `alternates injected a fabricated committed report (got ${JSON.stringify(reports)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-119 — a quoted `<<` false-arms the heredoc judge, hiding a real opener
// ===========================================================================

describe("RFC-1616 r9 — heredoc quote-armed false opener", () => {
  it(
    "CX-119: `echo '<<A x'` arms a heredoc bash never opens (the `<<` sits inside quotes); `cat <<B` then hides inside that fake body — a line `A` ends the fake arm and the gate commands inside B's REAL heredoc body are counted as invocations — dead CI is adopted",
    { timeout: 60_000 },
    async () => {
      const run = [
        `echo '<<A x'`,
        `cat <<B`,
        `A`,
        `forge correctness.gate --base HEAD~1`,
        `forge policy.digest --verify`,
        `forge pinned.validate`,
        `B`,
      ].join("\n");
      // Ground truth: run the block under real bash with a forge shim —
      // every forge line is stdin to cat, never executed.
      const scratch = mkdtempSync(path.join(os.tmpdir(), "cx9-bash-"));
      dirs.push(scratch);
      const marker = path.join(scratch, "forge-ran");
      const binDir = path.join(scratch, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        path.join(binDir, "forge"),
        `#!/bin/sh\necho FORGE-RAN > "${marker}"\nexit 0\n`,
      );
      chmodSync(path.join(binDir, "forge"), 0o755);
      writeFileSync(path.join(scratch, "run.sh"), `${run}\n`);
      const bashOut = execFileSync("bash", [path.join(scratch, "run.sh")], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}` },
      });
      expect(
        !existsSync(marker),
        `control: bash must prove the forge lines never execute (stdout=${JSON.stringify(bashOut.slice(0, 120))})`,
      ).toBe(true);

      // The judge counts them anyway — the workflow is adopted.
      expect(
        !adoptedWorkflow(workflowWithRun(run)),
        "a quoted `<<` armed a fake heredoc that hid the real opener — dead CI adopted",
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-120 — readCommittedEnvelope's raw `git show` serves the same pack
// forgery into the evidence-reuse judge → verification skipped on forged bytes
// ===========================================================================

describe("RFC-1616 r9 — committed-envelope reuse on forged bytes", () => {
  it(
    "CX-120: readCommittedEnvelope spawns `git show HEAD:<rel>` on a channel with no preflight, no pins and no re-hash — a pack-carried blob behind the committed envelope path feeds evaluateEvidenceReuse a fabricated `pass` envelope and the reuse verdict skips re-verification",
    { timeout: 90_000 },
    async () => {
      const root = repo("cx9-env-");
      writeFileSync(path.join(root, "a.txt"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      const BF = `deadbee${"1".repeat(33)}`;
      const envelope = [
        `rfcId: RFC-9001`,
        `emittedAt: "${new Date().toISOString()}"`,
        `acceptanceHash: "aaaa${"0".repeat(60)}"`,
        `overall: pass`,
        `resultsFrom: "${new Date().toISOString()}"`,
        `probes:`,
        `  - probe: file-exists`,
        `    ok: true`,
        `sentinel: PACK-FORGED-ENVELOPE`,
        ``,
      ].join("\n");
      // Committed path docs/rfcs/verification/env.generated.yaml → BF.
      const vt = mkTree(root, `100644 blob ${BF}\tenv.generated.yaml\n`);
      const rt = mkTree(root, `040000 tree ${vt}\tverification\n`);
      const dt = mkTree(root, `040000 tree ${rt}\trfcs\n`);
      const tt = mkTree(
        root,
        `040000 tree ${dt}\tdocs\n100644 blob ${gitIn(root, ["rev-parse", "HEAD:a.txt"]).trim()}\ta.txt\n`,
      );
      const c = gitIn(root, ["commit-tree", tt, "-m", "envelope"]).trim();
      gitIn(root, ["update-ref", "refs/heads/master", c]);
      forgePack(root, [{ sha: BF, type: 3, content: Buffer.from(envelope) }]);
      // Premise: git serves the forged envelope bytes.
      expect(gitIn(root, ["show", "HEAD:docs/rfcs/verification/env.generated.yaml"])).toBe(
        envelope,
      );

      const { envelope: env } = await readCommittedEnvelope(
        root,
        "docs/rfcs/verification/env.generated.yaml",
      );
      const verdict = evaluateEvidenceReuse({
        committed: env ?? null,
        acceptanceHashHex: `aaaa${"0".repeat(60)}`,
        disabled: false,
      });
      expect(
        !(env && verdict.reusable),
        `a pack-forged envelope passed the reuse judge (verdict=${JSON.stringify(verdict)}, sentinel=${JSON.stringify((env as unknown as Record<string, unknown>)?.["sentinel"])})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-121 — `.git/index` stat-forgery: clean status on dirty bytes
// ===========================================================================

describe("RFC-1616 r9 — index stat cache is a fabrication store", () => {
  it(
    "CX-121: a hand-written `.git/index` entry carrying the worktree file's live stat tuple but HEAD's blob sha makes `status --porcelain` answer clean on modified content — the gate's CORR-GATE-01 dirtiness read and isRfcFileClean's RFC-clean check are fabricated",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx9-idx-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      // Same-size dirty edit so every stat field still matches.
      writeFileSync(path.join(root, "a.txt"), "evil\n");
      // Racy-clean defeat: the file's mtime must be strictly OLDER than the
      // .git/index write that follows, else git re-hashes and sees the dirt.
      const past = new Date(Date.now() - 60_000);
      utimesSync(path.join(root, "a.txt"), past, past);

      const st = statSync(path.join(root, "a.txt"), { bigint: true });
      const headBlob = gitIn(root, ["rev-parse", "HEAD:a.txt"]).trim();
      const name = Buffer.from("a.txt");
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

      // Premise: raw git reports clean while the worktree byte differs.
      expect(gitIn(root, ["status", "--porcelain"])).toBe("");
      expect(gitIn(root, ["show", "HEAD:a.txt"])).not.toBe(
        readFileSync(path.join(root, "a.txt"), "utf8"),
      );
      // The trusted channels answer the same fabricated clean.
      const og = await createOriginGit(root).run(["status", "--porcelain", "--untracked-files=no"]);
      const ev = await gitEvidence(root, ["status", "--porcelain"]);
      expect(
        !(og === "" && ev.exitCode === 0 && ev.stdout === ""),
        `a forged index answered clean on both channels (origin=${JSON.stringify(og)}, evidence=${JSON.stringify(ev.stdout)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-122 — ambient-env git reads: listWorkspaceFiles spawns with process.env
// ===========================================================================

describe("RFC-1616 r9 — ambient environment on workspace listing", () => {
  it(
    "CX-122: `listWorkspaceFiles` execFile's `git ls-files` with NO env option — `GIT_INDEX_FILE`/`GIT_DIR` from the ambient session env redirect the --cached set, so a foreign index injects files the real repo ignores into 'every workspace file' and hides tracked ones",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx9-amb-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      writeFileSync(path.join(root, ".gitignore"), "hidden.md\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      writeFileSync(path.join(root, "hidden.md"), "secret\n");
      // Foreign index that tracks hidden.md (and not a.txt).
      const foreign = repo("cx9-foreign-");
      writeFileSync(path.join(foreign, "hidden.md"), "secret\n");
      gitIn(foreign, ["add", "hidden.md"]);

      const baseline = await listWorkspaceFiles(root);
      expect(baseline.includes("hidden.md")).toBe(false);
      const prevIdx = process.env["GIT_INDEX_FILE"];
      const prevDir = process.env["GIT_DIR"];
      process.env["GIT_INDEX_FILE"] = path.join(foreign, ".git", "index");
      process.env["GIT_DIR"] = path.join(foreign, ".git");
      try {
        const listed = await listWorkspaceFiles(root);
        expect(
          !listed.includes("hidden.md"),
          `ambient GIT_* injected a gitignored foreign file into the listing (got ${JSON.stringify(listed)})`,
        ).toBe(true);
      } finally {
        if (prevIdx === undefined) delete process.env["GIT_INDEX_FILE"];
        else process.env["GIT_INDEX_FILE"] = prevIdx;
        if (prevDir === undefined) delete process.env["GIT_DIR"];
        else process.env["GIT_DIR"] = prevDir;
      }
    },
  );
});

// ===========================================================================
// R9 controls — round-8 remediations re-verified live
// ===========================================================================

describe("RFC-1616 r9 — prior-round controls re-verified", () => {
  it(
    "R9-R1/R9-R8: `remote.o.r.uploadpack` (dotted remote, exec lever) and `reflog`/`stash`/`-c`/`--git-dir` argv stay refused on the verifier channel (CX-110/108/109)",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx9-ctrl-");
      writeFileSync(path.join(root, "a"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      const marker = path.join(root, ".up-marker");
      const hook = path.join(root, "up.sh");
      writeFileSync(hook, `#!/bin/sh\necho UP > "${marker}"\nexit 0\n`);
      chmodSync(hook, 0o755);
      gitIn(root, ["config", "remote.o.r.uploadpack", hook]);
      gitIn(root, ["config", "remote.o.r.url", root]);

      // CX-132: fetch is refused at the argv layer — the uploadpack lever
      // is unreachable regardless of remote-name shape.
      const fetch = await gitEvidence(root, ["fetch", "o.r"]);
      expect(fetch.exitCode !== 0).toBe(true);
      expect(existsSync(marker)).toBe(false);

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
    "R9-R2: `policy.digest --verify --base` still refuses dynamic revspecs (HEAD, master, :/msg) — the CX-103 fix",
    { timeout: 60_000 },
    async () => {
      const root = policyRepo();
      for (const rev of ["HEAD", "master", ":/seed"]) {
        const r = await runPolicyDigest(digestInp({ verify: true, base: rev }), digestCtx(root));
        expect(r.exitCode !== 0, `--base ${rev} was accepted (status=${r.data?.status})`).toBe(
          true,
        );
      }
    },
  );

  it(
    "R9-R3: heredoc r8 trio stays bash-faithful — `<<~EOF` (literal ~EOF), `<<'E'OF` (quote removal), `<<$EOF` (unarmable) never let dead CI count as adopted",
    { timeout: 60_000 },
    () => {
      // `<<~EOF`: bash's delimiter is the literal word `~EOF`; a later line
      // `EOF` must NOT terminate the body — the forge line inside stays dead.
      const t1 = workflowWithRun(
        ["cat <<~EOF", `forge correctness.gate`, "EOF", "~EOF"].join("\n"),
      );
      // `<<'E'OF`: quote removal arms EOF; the forge line inside the body
      // must not count.
      const t2 = workflowWithRun(["cat <<'E'OF", `forge correctness.gate`, "EOF"].join("\n"));
      // `<<$EOF`: expansion-bearing delimiter arms a never-matching
      // sentinel — body lines are stdin, never invocations.
      const t3 = workflowWithRun(["cat <<$EOF", `forge correctness.gate`, "EOF"].join("\n"));
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
    "R9-R4: a forged LOOSE object still refuses the evidence channel (CX-104a remediation holds)",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx9-loose-");
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
    "R9-R5: `cat-file --batch` batch reads re-hash served bytes — a forged loose blob answers null, never fabricated content",
    { timeout: 60_000 },
    async () => {
      const root = repo("cx9-batch-");
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
      const out = await createOriginGit(root).showMany?.([sha]);
      // The whole surface refuses once the loose scan sees the forgery —
      // showMany resolves null; if it ever answers entries, entry i must be
      // null (re-hash mismatch), never the forged bytes.
      expect(
        out == null || out[0] !== "forged",
        `batch served forged bytes: ${JSON.stringify(out)}`,
      ).toBe(true);
    },
  );

  it(
    "R9-R6: `<<-EOF` still refuses a space-indented terminator — the CX-100 strict match holds",
    { timeout: 30_000 },
    () => {
      const body = workflowWithRun(["cat <<-EOF", `forge correctness.gate`, " EOF"].join("\n"));
      // Space-indented terminator does not end `<<-`: the gate line stays
      // inside the body → nothing invoked → not adopted (fail closed).
      expect(!adoptedWorkflow(body)).toBe(true);
    },
  );
});
