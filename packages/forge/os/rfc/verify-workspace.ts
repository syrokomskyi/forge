/*
<MODULE_CONTRACT>
<purpose>
RFC-1333: rfc.verify.workspace — export a committed candidate as a plain tree
(no git metadata) for a clean-context acceptance verifier, stripped of the
implementer's in-range tests and of the RFC's plan, review, session, and queue
documents, with a VERIFY-BUNDLE.md carrying only the RFC's normative prose.
</purpose>
<non-goals>
  <item>Do not run the verifier — the fo-review acceptance mode does.</item>
  <item>Do not write inside the repository — the export lives under the OS temp dir.</item>
  <item>Do not hide anything cryptographically — the verifier is pointed at the export; isolation is recorded, not enforced.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>git archive piped into tar, never a worktree: a worktree shares the object database.</item>
  <item>A test file touched in range by any commit without the verifier trailer pair is stripped.</item>
  <item>node_modules (root included) are mirrored entry by entry with workspace links rewritten into the export.</item>
  <item>The candidate resolves to a full commit sha once; a failed export removes its partial tree.</item>
  <item>Directory links are junctions on Windows; path checks use forward slashes.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1333: initial implementation — git-free export, self-test and RFC-document stripping, VERIFY-BUNDLE.md.</item>
  <item>RFC-1333: review hardening — piped export, root node_modules mirroring, failure cleanup, sha resolution, Windows links.</item>
  <item>RFC-1580: digest trail, manifest review export, operating model and skills

flow.digest lists X-Correctness-Weakening trailers and verifier-trailer commits (correctnessTrail, part of digestId); rfc.verify.workspace --manifest exports the oracle-review surface with MANIFEST-REVIEW-BUNDLE.md hashes; operating model §7 product tiers and §8 'a self oracle never covers an anchor of a product correctness manifest'; fo-review oracle review mode producing forge/oracle-review@1; fo-idea-implement step 4.4c; correctness-gate reference page; forge AGENTS.md gate rules.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
  <item>RFC-1616: close RFC-1616 r9 trust-boundary counterexamples

Independent clean-context verification (round 9, candidate 4436339db)
returned REFUTED with ten live counterexamples against the r8-hardened
evidence channel — this commit closes all root causes.

- Pack-carried objects get the loose-sweep integrity anchor: every
  .idx/.pack pair under objects/pack is verify-pack -s'd at preflight
  and the sweep memo key is the unforgeable (ino, ctimeMs, size) stat
  triple (CX-113/114); pack.useBitmapIndex=false pins the bitmap
  reachability cache off.
- Every trusted-path git call routes through the judged/preflighted
  channel: execGit/readCommittedEnvelope/readAcceptanceReports/
  listWorkspaceFiles and the snapshot gitGrep closure now run
  verifierGit/createOriginGit with structured fail-closed dirty
  verdicts (CX-115/118/120/122).
- Export materialization no longer trusts git archive, ambient tar, or
  committed .gitattributes: exportTree enumerates ls-tree -r -z and
  materializes committed bytes through the re-hashed cat-file --batch
  channel, bounding symlink targets to the export root (CX-116/117).
- Index-consulting reads run on a verifier-owned claims rebuild:
  prepareEvidenceIndex copies staged object claims into a fresh index
  with zeroed stat metadata, so status/diff content-hash the worktree
  instead of trusting a session-written stat tuple (CX-121).
- The heredoc lexer is quote-aware: a << inside quotes is string
  content, never an operator (CX-119).
- Pins ride GIT_CONFIG_* env so the spawned argv stays the judged
  query verbatim; diff.external moved from a broken pin to
  refuse-on-presence; OriginGit.run/runExit now judge caller argv with
  the same read table; batch stdin is EPIPE-safe.
- kernel-source-scan models the two channel files as judged bodies so
  the channel migration does not read as new unguarded subprocess hits
  in the werkstatt-site mutation ratchet.

The independent r9 probe file and acceptance report land in the
follow-up port commit.</item>
</CHANGE_SUMMARY>
*/

import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { verifierGit } from "../../src/utils/verifier-git.ts";
import { listRfcFiles, readAndParseRfc, rfcFileMatchesId } from "./frontmatter-io.ts";
import { RFC_DIR } from "./types.ts";
import {
  createOriginGit,
  hasVerifierTrailers,
  resolveImplementationRange,
  type OriginGit,
} from "./verification-origin.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../src/types.ts";

export interface RfcVerifyWorkspaceResult {
  command: "rfc.verify.workspace";
  status: "pass" | "fail";
  rfcId: string;
  candidateSha: string;
  path: string | null;
  removed: string[];
  error?: string;
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;
const DOC_DIRS = ["docs/plans/", "docs/reviews/", "docs/sessions/", "docs/queues/"];
const BUNDLE_SECTIONS = ["Context", "Problem", "Decision", "Design", "Acceptance criteria"];

const toPosix = (p: string): string => p.split(sep).join("/");

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // verifierGit: --candidate argv is session-shaped input, so the read goes
  // through positional judgment, config pinning, and ambient-env scrubbing
  // rather than a raw execFile (CX-113/CX-122).
  const r = await verifierGit(cwd, args);
  return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr };
}

/** Test files touched in base..head by at least one commit without the verifier trailer pair. */
export async function listSelfTestFiles(
  git: OriginGit,
  base: string,
  head: string,
): Promise<string[]> {
  const out = await git.run([
    "log",
    "--first-parent",
    "-m",
    "--format=%x1e%H%x1f%B%x1f",
    "--name-only",
    `${base}..${head}`,
  ]);
  if (!out) return [];
  const self = new Set<string>();
  for (const chunk of out.split("\x1e")) {
    const [, body = "", files = ""] = chunk.split("\x1f");
    if (hasVerifierTrailers(body)) continue;
    for (const f of files.split("\n").map((l) => l.trim())) if (TEST_FILE_RE.test(f)) self.add(f);
  }
  return [...self].sort();
}

/** Keep only the normative sections of the RFC body. */
export function extractBundleSections(body: string): string {
  return body
    .split(/^(?=## )/m)
    .filter((p) => BUNDLE_SECTIONS.some((h) => new RegExp(`^## ${h}\\r?\\n`).test(p)))
    .join("\n")
    .trim();
}

/** Directory links use junctions on Windows (no Developer Mode needed). */
async function linkPath(target: string, dst: string): Promise<void> {
  const isDir = (await lstat(target).catch(() => null))?.isDirectory() ?? true;
  const type = isDir ? (process.platform === "win32" ? "junction" : "dir") : "file";
  await symlink(target, dst, type);
}

/**
 * Mirror `<pkg>/node_modules` (root included) entry by entry. A link that
 * resolves inside the repository but outside any node_modules is a workspace
 * link and is rewritten into the export, so siblings run at the candidate.
 */
async function mirrorNodeModules(mainRoot: string, outRoot: string, pkgRel: string): Promise<void> {
  const srcDir = join(mainRoot, pkgRel, "node_modules");
  const dstDir = join(outRoot, pkgRel, "node_modules");
  if (!existsSync(srcDir) || existsSync(dstDir)) return;
  await mkdir(dstDir, { recursive: true });
  const link = async (rel: string): Promise<void> => {
    const src = join(srcDir, rel);
    let target = src;
    if ((await lstat(src)).isSymbolicLink()) {
      const resolved = resolve(dirname(src), await readlink(src));
      const inRepo = toPosix(relative(mainRoot, resolved));
      const workspaceLink =
        !inRepo.startsWith("..") &&
        inRepo !== "node_modules" &&
        !inRepo.startsWith("node_modules/") &&
        !inRepo.includes("/node_modules/");
      target = workspaceLink ? join(outRoot, inRepo) : resolved;
    }
    await mkdir(dirname(join(dstDir, rel)), { recursive: true });
    await linkPath(target, join(dstDir, rel));
  };
  for (const name of await readdir(srcDir)) {
    if (name.startsWith("@")) {
      for (const sub of await readdir(join(srcDir, name))) await link(join(name, sub));
    } else {
      await link(name);
    }
  }
}

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  size: number;
  path: string;
}

/**
 * Materialize a committed tree as plain files — no `git archive`, no tar
 * (CX-116: `tar` resolved through ambient PATH could be a session shim;
 * CX-117: archive honors `.gitattributes` export-ignore/export-subst/eol
 * rewrites, so the exported bytes were NOT the committed bytes). Direct
 * `ls-tree` enumeration plus re-hashed `cat-file --batch` blob reads is
 * byte-faithful to the committed tree by construction, attributes never
 * apply, and nothing but the pinned git binary executes.
 */
async function exportTree(git: OriginGit, sha: string, out: string): Promise<string | null> {
  if (!git.runExit || !git.showManyBytes) {
    return "trusted git channel lacks byte-faithful reads";
  }
  const listed = await git.runExit(["ls-tree", "-r", "-z", "-l", sha]);
  if (listed === null || listed.code !== 0 || !listed.bytes) {
    return "ls-tree failed — committed tree unreadable";
  }
  const entries: TreeEntry[] = [];
  for (const rec of listed.bytes.toString("utf8").split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const meta = tab === -1 ? rec : rec.slice(0, tab);
    const p = tab === -1 ? "" : rec.slice(tab + 1);
    const m = /^(\d+) (\S+) ([0-9a-f]{40,64})\s+(-|\d+)$/.exec(meta);
    if (!m || !p) return `ls-tree record unparsed: ${JSON.stringify(rec.slice(0, 80))}`;
    entries.push({
      mode: m[1]!,
      type: m[2]!,
      sha: m[3]!,
      size: m[4] === "-" ? 0 : Number(m[4]),
      path: p,
    });
  }
  // A committed path must never write outside the export root.
  for (const e of entries) {
    if (e.path.startsWith("/") || e.path.split("/").includes("..") || /^[a-zA-Z]:/.test(e.path)) {
      return `refusing path outside the export root: ${e.path}`;
    }
  }
  // Blobs are read in chunks bounded by cumulative size so each batch stays
  // under the channel's maxBuffer; gitlinks and tree records carry no blob.
  const BLOB_CHUNK_BYTES = 48 * 1024 * 1024;
  const blobs = entries.filter((e) => e.type === "blob");
  for (const e of entries) {
    if (e.type === "commit") {
      // gitlink — git archive leaves an empty directory for a submodule.
      await mkdir(join(out, ...e.path.split("/")), { recursive: true });
    }
  }
  for (let i = 0; i < blobs.length;) {
    const chunk: TreeEntry[] = [];
    let acc = 0;
    while (i < blobs.length && (chunk.length === 0 || acc + blobs[i]!.size <= BLOB_CHUNK_BYTES)) {
      acc += blobs[i]!.size;
      chunk.push(blobs[i]!);
      i++;
    }
    const got = await git.showManyBytes(chunk.map((c) => c.sha));
    if (got === null) return "cat-file --batch failed — committed tree unreadable";
    for (let j = 0; j < chunk.length; j++) {
      const buf = got[j];
      if (buf === null || buf === undefined) {
        return `blob ${chunk[j]!.sha} (${chunk[j]!.path}) unreadable`;
      }
      const abs = join(out, ...chunk[j]!.path.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      if (chunk[j]!.mode === "120000") {
        // A committed symlink's blob is its target path — but the target is
        // session-authored too: an absolute or root-escaping link would let a
        // reviewer read outside the export. Only an in-bounds relative target
        // is materialized as a link; anything else lands as the target text.
        const target = buf.toString("utf8");
        const inBounds =
          !target.startsWith("/") &&
          !/^[a-zA-Z]:/.test(target) &&
          resolve(dirname(abs), target).startsWith(resolve(out) + sep);
        try {
          if (inBounds) await symlink(target, abs);
          else await writeFile(abs, buf);
        } catch {
          await writeFile(abs, buf);
        }
      } else {
        await writeFile(abs, buf);
        if (chunk[j]!.mode === "100755") await chmod(abs, 0o755);
      }
    }
  }
  return null;
}

export async function buildVerifyWorkspace(opts: {
  workspaceRoot: string;
  rfcId: string;
  candidateSha: string;
  outDir?: string;
}): Promise<RfcVerifyWorkspaceResult> {
  const { workspaceRoot, rfcId } = opts;
  // Resolve once to a full commit sha: a moving branch name must not shift the binding.
  const resolved = (
    await runGit(workspaceRoot, ["rev-parse", "--verify", `${opts.candidateSha}^{commit}`])
  ).stdout.trim();
  const candidateSha = resolved || opts.candidateSha;
  const fail = (error: string): RfcVerifyWorkspaceResult => ({
    command: "rfc.verify.workspace",
    status: "fail",
    rfcId,
    candidateSha,
    path: null,
    removed: [],
    error,
  });
  if (!resolved) return fail(`candidate ${opts.candidateSha} is not a commit`);

  const rfcDir = join(workspaceRoot, RFC_DIR);
  const fileName = (await listRfcFiles(rfcDir)).find((f) => rfcFileMatchesId(f, rfcId));
  if (!fileName) return fail(`${rfcId} not found`);
  const parsed = await readAndParseRfc(rfcDir, fileName);
  if (!parsed || "error" in parsed) return fail(`${rfcId} unparseable`);

  const git = createOriginGit(workspaceRoot);
  const rfcRel = toPosix(relative(workspaceRoot, join(rfcDir, fileName)));
  const range = await resolveImplementationRange(git, rfcRel);
  if (!range.base) return fail(`${rfcId} has no status: accepted transition in history`);
  const selfTests = await listSelfTestFiles(git, range.base, candidateSha);

  const selfCreated = opts.outDir === undefined;
  const out = opts.outDir ?? (await mkdtemp(join(tmpdir(), `rfc-verify-${rfcId.toLowerCase()}-`)));
  let result: RfcVerifyWorkspaceResult;
  try {
    await mkdir(out, { recursive: true });
    const exportError = await exportTree(git, candidateSha, out);
    if (exportError) {
      result = fail(`export failed: ${exportError}`);
    } else {
      const removed: string[] = [];
      const drop = async (rel: string): Promise<void> => {
        if (existsSync(join(out, rel))) {
          await rm(join(out, rel), { recursive: true, force: true });
          removed.push(rel);
        }
      };
      for (const f of selfTests) await drop(f);
      const idRe = new RegExp(`\\b${rfcId}\\b`, "i");
      const tracked = (
        await runGit(workspaceRoot, ["ls-tree", "-r", "--name-only", candidateSha])
      ).stdout.split("\n");
      for (const f of tracked) {
        if (!DOC_DIRS.some((d) => f.startsWith(d))) continue;
        const abs = join(out, f);
        if (existsSync(abs) && (idRe.test(f) || idRe.test(await readFile(abs, "utf8")))) {
          await drop(f);
        }
      }
      const slug = rfcId.toLowerCase();
      await drop(`${RFC_DIR}/verification/${slug}.generated.yaml`);
      await drop(`docs/metrics/rfcs/${slug}.metrics.yaml`);

      await mirrorNodeModules(workspaceRoot, out, ".");
      for (const pj of tracked.filter(
        (f) => f.endsWith("/package.json") && !f.includes("node_modules/"),
      )) {
        await mirrorNodeModules(workspaceRoot, out, dirname(pj));
      }

      await writeFile(
        join(out, "VERIFY-BUNDLE.md"),
        [
          `# Acceptance verification bundle — ${rfcId}`,
          "",
          `Candidate: ${candidateSha}`,
          "",
          "Removed from this tree (exists in the candidate, intentionally hidden):",
          ...removed.map((r) => `- ${r}`),
          "",
          extractBundleSections(parsed.parsed.body),
          "",
        ].join("\n"),
      );
      result = {
        command: "rfc.verify.workspace",
        status: "pass",
        rfcId,
        candidateSha,
        path: out,
        removed,
      };
    }
  } catch (e) {
    result = fail(e instanceof Error ? e.message : String(e));
  }
  // A failed export must not leave a partial tree behind.
  if (result.status === "fail" && selfCreated) await rm(out, { recursive: true, force: true });
  return result;
}

/** RFC-1580: narrative directories stripped from an oracle-review export. */
const MANIFEST_STRIP_DIRS = [
  "docs/plans/",
  "docs/reviews/",
  "docs/sessions/",
  "docs/handoffs/",
  "docs/audits/",
  "docs/queues/",
  "docs/explorations/",
  "docs/metrics/",
  "docs/rfcs/verification/",
  ".agents/memory/",
  ".agents/notes/",
];

/**
 * RFC-1580: export a committed candidate for a clean-context oracle review —
 * the manifest, requirement documents, anchored code, oracle and support
 * files, and captures stay; narrative directories are stripped;
 * MANIFEST-REVIEW-BUNDLE.md lists every manifest oracle with its sha256 (the
 * value a forge/oracle-review@1 record must name).
 */
export async function buildManifestReviewWorkspace(opts: {
  workspaceRoot: string;
  candidateSha: string;
  outDir?: string;
}): Promise<RfcVerifyWorkspaceResult> {
  const { workspaceRoot } = opts;
  const resolved = (
    await runGit(workspaceRoot, ["rev-parse", "--verify", `${opts.candidateSha}^{commit}`])
  ).stdout.trim();
  const candidateSha = resolved || opts.candidateSha;
  const fail = (error: string): RfcVerifyWorkspaceResult => ({
    command: "rfc.verify.workspace",
    status: "fail",
    rfcId: "",
    candidateSha,
    path: null,
    removed: [],
    error,
  });
  if (!resolved) return fail(`candidate ${opts.candidateSha} is not a commit`);
  const selfCreated = opts.outDir === undefined;
  const out = opts.outDir ?? (await mkdtemp(join(tmpdir(), "rfc-verify-manifest-")));
  let result: RfcVerifyWorkspaceResult;
  try {
    await mkdir(out, { recursive: true });
    const exportError = await exportTree(createOriginGit(workspaceRoot), candidateSha, out);
    if (exportError) {
      result = fail(`export failed: ${exportError}`);
    } else {
      const tracked = (
        await runGit(workspaceRoot, ["ls-tree", "-r", "--name-only", candidateSha])
      ).stdout.split("\n");
      const removed: string[] = [];
      // Earlier review verdicts stay hidden from the reviewer.
      const stripDirs = [...MANIFEST_STRIP_DIRS];
      try {
        const cfgText = await readFile(join(out, "forge.yaml"), "utf8");
        const rd = /^\s*oracleReviewsDir:\s*["']?([^"'\s#]+)/m.exec(cfgText)?.[1];
        stripDirs.push(`${(rd ?? "docs/correctness/reviews").replace(/\/$/, "")}/`);
      } catch {
        stripDirs.push("docs/correctness/reviews/");
      }
      for (const dir of stripDirs) {
        if (tracked.some((f) => f.startsWith(dir)) && existsSync(join(out, dir))) {
          await rm(join(out, dir), { recursive: true, force: true });
          removed.push(dir.replace(/\/$/, ""));
        }
      }
      await mirrorNodeModules(workspaceRoot, out, ".");
      for (const pj of tracked.filter(
        (f) => f.endsWith("/package.json") && !f.includes("node_modules/"),
      )) {
        await mirrorNodeModules(workspaceRoot, out, dirname(pj));
      }
      const { parse } = await import("yaml");
      const { createHash } = await import("node:crypto");
      let manifestRel: string | null = null;
      try {
        const cfg = parse(await readFile(join(out, "forge.yaml"), "utf8")) as {
          bindings?: { paths?: { correctnessManifest?: unknown } };
        };
        const p = cfg?.bindings?.paths?.correctnessManifest;
        manifestRel = typeof p === "string" ? p : null;
      } catch {
        manifestRel = null;
      }
      const lines = [
        "# Oracle review bundle (forge/oracle-review@1)",
        "",
        `Candidate: ${candidateSha}`,
        `Manifest: ${manifestRel ?? "(none bound)"}`,
        "",
        "For every oracle: does it exercise its entry's requirement, assert against the attested handle (not a second, mocked one), and make its substrate claim plausibly? Record verdicts in a forge/oracle-review@1 file naming each check with the sha256 below.",
        "",
        "Removed from this tree (narrative, intentionally hidden):",
        ...removed.map((r) => `- ${r}`),
        "",
        "| Entry | Check | Substrate | sha256 |",
        "| --- | --- | --- | --- |",
      ];
      if (manifestRel) {
        try {
          const manifest = parse(await readFile(join(out, manifestRel), "utf8")) as {
            entries?: { id?: string; oracles?: { check?: string; substrate?: string }[] }[];
          };
          for (const entry of manifest?.entries ?? []) {
            for (const o of entry.oracles ?? []) {
              const target = String(o.check ?? "")
                .replace(/^[a-z]+:/, "")
                .replace(/^\.\//, "");
              // Hash the committed blob (git show) — the bytes the gate hashes —
              // not the archive export, which eol/export-subst attributes may alter.
              const blob = await runGit(workspaceRoot, ["show", `${candidateSha}:${target}`]);
              const digest = blob.ok
                ? createHash("sha256").update(blob.stdout).digest("hex")
                : "(missing)";
              lines.push(
                `| ${entry.id ?? "?"} | ${o.check ?? "?"} | ${o.substrate ?? "?"} | ${digest} |`,
              );
            }
          }
        } catch {
          lines.push("| (manifest unreadable) | | | |");
        }
      }
      await writeFile(join(out, "MANIFEST-REVIEW-BUNDLE.md"), `${lines.join("\n")}\n`);
      result = {
        command: "rfc.verify.workspace",
        status: "pass",
        rfcId: "",
        candidateSha,
        path: out,
        removed,
      };
    }
  } catch (e) {
    result = fail(e instanceof Error ? e.message : String(e));
  }
  if (result.status === "fail" && selfCreated) await rm(out, { recursive: true, force: true });
  return result;
}

export async function runRfcVerifyWorkspace(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcVerifyWorkspaceResult>> {
  const rfcId = String(input.flags["id"] ?? "").toUpperCase();
  const candidateSha = String(input.flags["candidate"] ?? "");
  if (input.flags["manifest"] === true) {
    if (!candidateSha) {
      return { exitCode: 1, summary: "rfc.verify.workspace --manifest: --candidate is required" };
    }
    const data = await buildManifestReviewWorkspace({
      workspaceRoot: context.workspaceRoot,
      candidateSha,
    });
    return {
      data,
      exitCode: data.status === "pass" ? 0 : 1,
      summary:
        data.status === "pass"
          ? `rfc.verify.workspace --manifest: ${candidateSha.slice(0, 9)} → ${data.path} (${data.removed.length} narrative dir(s) hidden; see MANIFEST-REVIEW-BUNDLE.md)`
          : `rfc.verify.workspace --manifest: ${data.error}`,
    };
  }
  if (!rfcId || !candidateSha) {
    const data: RfcVerifyWorkspaceResult = {
      command: "rfc.verify.workspace",
      status: "fail",
      rfcId,
      candidateSha,
      path: null,
      removed: [],
      error: "--id and --candidate are required",
    };
    return {
      data,
      exitCode: 1,
      summary: "rfc.verify.workspace: --id and --candidate are required",
    };
  }
  const data = await buildVerifyWorkspace({
    workspaceRoot: context.workspaceRoot,
    rfcId,
    candidateSha,
  });
  return {
    data,
    exitCode: data.status === "pass" ? 0 : 1,
    summary:
      data.status === "pass"
        ? `rfc.verify.workspace: ${rfcId} at ${candidateSha.slice(0, 9)} → ${data.path} (${data.removed.length} path(s) hidden)`
        : `rfc.verify.workspace: ${data.error}`,
  };
}
