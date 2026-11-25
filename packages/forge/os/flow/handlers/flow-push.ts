/*
<MODULE_CONTRACT>
<purpose>flow.push — the only outbound path (RFC-1491): refuse preflight
FLOW-PUSH-01/02/03/06/07, run the atomic push of develop+main+tags under
FORGE_FLOW_OP=push, journal the push, then publish the package-line tags
(this run's pushed tags only, minus baseline) through repo-extract with
a single ours-merge reconcile — never force-push, never a manual push
path.</purpose>
<non-goals>
  <item>No digest computation beyond collectDigest — digest.ts owns the shape.</item>
  <item>No real repo-extract in tests — fixtures install a fake binary.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The digest must be quoted: a recomputed digestId mismatch refuses FLOW-PUSH-02 and names the new id, so the operator always pushes what they reviewed.</item>
  <item>Publication candidates are this run's pushed tags only — journal `push` records are suppressor-only (R13-C): they can hide a tag from digest.tags but never mint eligibility, so a pushed-but-unpublished tag leaves the candidate set rather than trusting a session-writable retry ledger.</item>
  <item>Publication failures are FLOW-PUSH-05 per tag; the command continues with the next tag and exits non-zero at the end.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1616: close r21 counterexample CX-179 + push-scan refusal polarity</item>
  <item>RFC-1633: serialize evidence consults + bestEffort reader mode (RFC-1633)</item>
  <item>RFC-1638: persist reviewed digests + attest pushed state by input hash</item>
  <item>RFC-1638: review round 1 — payload preimage binding, fail-closed coverage scan, FLOW-PUSH-15</item>
  <item>RFC-1643: committed verifier-review baseline for flow.push</item>
  <history>RFC-1491, RFC-1501, RFC-1503, RFC-1616</history>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { parse as parseYaml } from "yaml";
import {
  collectDigest,
  digestInputHash,
  lineForTag,
  loadPersistedDigest,
  observeDigestInputs,
  recomputePersistedDigestId,
  versionOfTag,
  type FlowDigestData,
} from "../digest.ts";
import {
  assertJudgedEvidence,
  git,
  gitEvidence,
  parseGitTrailers,
  requireGit,
  verifierTopLevel,
} from "../git.ts";
import { EVIDENCE_REFUSED_PREFIX } from "../../../src/utils/verifier-git.ts";
import { markerIsValid } from "../markers.ts";
import { publishTag, tagAnnotationLevel, type PublicationRow } from "../publish.ts";
import { planPublications, type PublicationPlanEntry } from "../publication-order.ts";
import { appendJournal, commonGitDir, FlowRegistrySchemaError, readJournal } from "../registry.ts";
import { discoverReleaseLines, type ReleaseLine } from "../release-lines.ts";
import { primaryWorktree } from "../worktree-path.ts";

export interface FlowPushData {
  digestId: string;
  pushed: boolean;
  refs: string[];
  publications: PublicationRow[];
  /** RFC-1503: pending tags superseded this run — `{ tag, by }`. */
  superseded: Array<{ tag: string; by: string }>;
  /** RFC-1503: tags with a publish-retired journal record (informational). */
  retired: string[];
  diagnostics: Diagnostic[];
  /** RFC-1501: whether the preflight digest fetched origin; absent on early refusals. */
  fetched?: boolean;
  /**
   * RFC-1616 (AC-6): unpushed commits whose bodies carry a verifier/audit
   * trailer — `{ sha, trailers }`. Populated whenever the scan ran (also on
   * the accepted path, so the operator sees what the flag covered).
   */
  verifierTrailerCommits?: Array<{ sha: string; trailers: string[] }>;
  /** RFC-1616: the operator reason passed to --accept-verifier-trailers, when accepted. */
  verifierTrailersAccepted?: string;
  /** RFC-1643: how the committed review baseline was judged; absent when the scan did not run. */
  verifierReviewBaseline?: {
    status: "absent" | "applied" | "unusable";
    declared?: string;
    reason?: VerifierReviewBaselineReason;
    /** Full shas of hits the baseline exempted, sorted. */
    exempted: string[];
    /** Subset of `exempted` the previous baseline did not cover. */
    newlyExempted: string[];
    /** The first-parent commit that last changed the parsed value, when found. */
    bumpedBy?: string;
    /** Every parsed-value change in the walk window, newest first. */
    changes: BaselineChange[];
  };
  /** RFC-1638: how the quoted digest was validated — persisted-input attestation or full recount. */
  attestation?: "input-hash" | "recount";
  /** RFC-1638: when the reviewed digest was computed (attestation path). */
  digestComputedAt?: string;
}

/** RFC-1616: the commit trailers the push-time verifier-review scan flags. */
const VERIFIER_TRAILERS = [
  "X-Expectation-Origin",
  "X-Verifier-Report",
  "X-Correctness-Weakening",
  "X-Policy-Digest",
] as const;

function refuse(ruleId: string, message: string, fixHint?: string): FlowPushData {
  return {
    digestId: "",
    pushed: false,
    refs: [],
    publications: [],
    superseded: [],
    retired: [],
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

/**
 * Core of flow.push — callable in tests. Every refusal is a diagnostic in
 * the returned data; nothing leaves the machine unless pushed: true.
 */
/**
 * RFC-1616 (AC-6): list commits in `range` whose message carries a verifier /
 * audit trailer. Commit SHAs enumerate via `rev-list` (hex-only output) and
 * each commit's trailers arrive through git's OWN `%(trailers:only)` parser —
 * `x-verifier-report:`/`X-Verifier-Report :` spellings count exactly as
 * `git interpret-trailers` counts them (CX-60). The channel is
 * `gitEvidence`: session GIT_* variables and refs/replace cannot redirect
 * or substitute what the scan sees (CX-48).
 *
 * F-0394: the range is the whole local branch (CX-82/CX-132), and every
 * judged consult re-runs the full evidence preflight (seconds each), so a
 * per-commit read pair walked tens of thousands of consults — ~85 h on an
 * 18k-commit repo. The scan now reads the range in TWO batched judged
 * consults (`batchedCommitReads`) and falls back to the exact per-commit
 * reads whenever the batch cannot be proven to frame one record per
 * enumerated sha (CX-33) — the per-record judgment is byte-identical on
 * both paths.
 */
async function scanVerifierTrailers(
  repoRoot: string,
  io: WorkspaceIO,
  range: string,
): Promise<Array<{ sha: string; trailers: string[] }> | null> {
  const list = await gitEvidence(repoRoot, ["rev-list", range]);
  assertJudgedEvidence(list);
  // Any failure on an enumerable range is unverifiable — `[]` would run
  // the trailer scan over nothing (CX-174's shape inside the push gate
  // itself); null lets the caller refuse loudly.
  if (list.exitCode !== 0) return null;
  const shas = list.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (shas.length === 0) return [];
  const batched = await batchedCommitReads(repoRoot, range, shas);
  const hits: Array<{ sha: string; trailers: string[] }> = [];
  for (const sha of shas) {
    const reads = batched?.get(sha) ?? (await perCommitReads(repoRoot, sha));
    const found = judgeVerifierTrailers(reads);
    if (found.length > 0) hits.push({ sha, trailers: found });
  }
  return hits;
}

/** One commit's two judged reads: `null` = that read failed (unverifiable). */
interface CommitReads {
  /** stdout of `log -1 --format=%(trailers:only,separator=%x00)%x00%e <sha>`. */
  trailers: string | null;
  /** stdout of `log -1 --format=%s <sha>`. */
  subject: string | null;
}

const TRAILER_READ_FORMAT = "%(trailers:only,separator=%x00)%x00%e";

/** The exact pre-F-0394 per-commit reads — two judged consults per sha. */
async function perCommitReads(repoRoot: string, sha: string): Promise<CommitReads> {
  // `%e` rides along — a commit declaring a non-default `encoding:`
  // header RECODES this very output, so %(trailers) over it is already
  // garbage: the header lives in the object and no -c pin reaches it
  // (CX-102). An encoded commit's trailers are unverifiable — flag it.
  const parsed = await gitEvidence(repoRoot, ["log", "-1", `--format=${TRAILER_READ_FORMAT}`, sha]);
  assertJudgedEvidence(parsed);
  // `%s` is one line — no delimiter to smuggle.
  const subj = await gitEvidence(repoRoot, ["log", "-1", "--format=%s", sha]);
  assertJudgedEvidence(subj);
  return {
    trailers: parsed.exitCode === 0 ? parsed.stdout : null,
    subject: subj.exitCode === 0 ? subj.stdout : null,
  };
}

/**
 * F-0394: both reads for every commit of `range` in two judged consults.
 * Each record is `\x1e<sha>\x00<per-commit read output>` — the payload
 * after the sha prefix is exactly what `perCommitReads` would have read.
 * A \x1e or forged `<sha>\x00` inside a message can only ADD records
 * (separators are never consumed), so the batch is accepted only when
 * every record carries an enumerated sha, no sha repeats, and the record
 * count equals the `rev-list` count (CX-33). Any mismatch, failure or
 * refusal returns null and the caller reads per commit — slow but exact,
 * never a narrower scan.
 */
export async function batchedCommitReads(
  repoRoot: string,
  range: string,
  shas: readonly string[],
): Promise<Map<string, CommitReads> | null> {
  const trailerRecords = await batchedRecords(repoRoot, range, TRAILER_READ_FORMAT, shas);
  if (trailerRecords === null) return null;
  const subjectRecords = await batchedRecords(repoRoot, range, "%s", shas);
  if (subjectRecords === null) return null;
  const out = new Map<string, CommitReads>();
  for (const sha of shas) {
    out.set(sha, { trailers: trailerRecords.get(sha)!, subject: subjectRecords.get(sha)! });
  }
  return out;
}

async function batchedRecords(
  repoRoot: string,
  range: string,
  format: string,
  shas: readonly string[],
): Promise<Map<string, string> | null> {
  const r = await gitEvidence(repoRoot, ["log", `--format=%x1e%H%x00${format}`, range]);
  assertJudgedEvidence(r);
  if (r.exitCode !== 0) return null;
  const expected = new Set(shas);
  const parts = r.stdout.split("\x1e");
  // The output starts with the separator — anything before it is foreign.
  if (parts.shift() !== "") return null;
  if (parts.length !== expected.size) return null;
  const records = new Map<string, string>();
  for (const part of parts) {
    const nul = part.indexOf("\x00");
    if (nul <= 0) return null;
    const sha = part.slice(0, nul);
    if (!expected.has(sha) || records.has(sha)) return null;
    records.set(sha, part.slice(nul + 1));
  }
  return records.size === expected.size ? records : null;
}

/** Verifier/audit trailers one commit's reads carry, sorted; [] = clean. */
function judgeVerifierTrailers(reads: CommitReads): string[] {
  const wanted = new Set(VERIFIER_TRAILERS.map((t) => t.toLowerCase()));
  const canonical = new Map(VERIFIER_TRAILERS.map((t) => [t.toLowerCase(), t]));
  if (reads.trailers === null) {
    // An enumerated commit whose trailer read fails is unverifiable —
    // flag it like the encoding case instead of silently dropping its
    // provenance under a surgical refusal.
    return ["x-unverifiable-commit"];
  }
  const parsedParts = reads.trailers.split("\x00");
  const declaredEncoding = (parsedParts.pop() ?? "").trim();
  const found = new Set<string>();
  if (declaredEncoding.length > 0 && !/^utf-?8$/i.test(declaredEncoding)) {
    found.add(`x-unverifiable-encoding: ${declaredEncoding}`);
  }
  for (const t of parseGitTrailers(parsedParts.join("\x00").replaceAll("\x00", "\n"))) {
    const c = canonical.get(t.key);
    if (wanted.has(t.key) && c && t.value.length > 0) found.add(c);
  }
  // A trailer-shaped SUBJECT is not a git trailer on every version — but it
  // looks exactly like provenance text, so flag it anyway (stricter is
  // safe, CX-23).
  if (reads.subject !== null) {
    const m = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(reads.subject.trim());
    if (m) {
      const c = canonical.get(m[1]!.trim().toLowerCase());
      if (c && m[2]!.trim().length > 0) found.add(c);
    }
  } else {
    // The subject-shaped-trailer check could not run — flag the sha
    // rather than assume no trailer-shaped subject.
    found.add("x-unverifiable-commit");
  }
  return [...found].sort();
}

/** RFC-1643: why a declared review baseline exempts nothing. */
export type VerifierReviewBaselineReason =
  "malformed" | "unknown" | "not-a-commit" | "not-ancestor" | "unverifiable";

/** RFC-1643: the judged state of `push.verifierReviewedThrough`. */
export type VerifierReviewBaseline =
  | { status: "absent" }
  | { status: "applied"; sha: string }
  | { status: "unusable"; declared: string; reason: VerifierReviewBaselineReason };

/** RFC-1643: the committed `forge.yaml` at a sha — `unverifiable` on a refused read. */
type CommittedForgeDoc =
  | { kind: "doc"; doc: Record<string, unknown> | null; raw: string }
  | { kind: "missing" }
  | { kind: "unparsable"; raw: string }
  | { kind: "unverifiable" };

async function readCommittedForgeDoc(repoRoot: string, rev: string): Promise<CommittedForgeDoc> {
  const show = await gitEvidence(repoRoot, ["show", `${rev}:forge.yaml`]);
  assertJudgedEvidence(show);
  if (show.exitCode === -1) return { kind: "unverifiable" };
  if (show.exitCode !== 0) return { kind: "missing" };
  try {
    // `yaml` rejects duplicate keys by default — a shadowed `push:` block
    // is a parse error, never a silently-chosen winner.
    const doc = parseYaml(show.stdout) as unknown;
    return {
      kind: "doc",
      doc: typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : null,
      raw: show.stdout,
    };
  } catch {
    return { kind: "unparsable", raw: show.stdout };
  }
}

function pushSection(doc: Record<string, unknown> | null): Record<string, unknown> | undefined {
  const push = doc?.["push"];
  return typeof push === "object" && push !== null && !Array.isArray(push)
    ? (push as Record<string, unknown>)
    : undefined;
}

/** The raw declared baseline in a committed doc — `undefined` when absent. */
function declaredBaseline(doc: CommittedForgeDoc): unknown {
  if (doc.kind !== "doc") return undefined;
  const v = pushSection(doc.doc)?.["verifierReviewedThrough"];
  return v === null ? undefined : v;
}

/**
 * RFC-1643: judge `push.verifierReviewedThrough` from the committed
 * forge.yaml at the digest-reviewed develop tip. Every read is a judged
 * consult; every failure exempts nothing (fail closed). Only a full,
 * lower-case object name of the repository's format that names a commit
 * reachable from `refs/heads/develop` (re-read, must equal `developTip`)
 * is `applied`.
 */
export async function resolveVerifierReviewBaseline(
  repoRoot: string,
  developTip: string,
  committed: CommittedForgeDoc,
): Promise<VerifierReviewBaseline> {
  if (committed.kind === "unverifiable") {
    return { status: "unusable", declared: "", reason: "unverifiable" };
  }
  if (committed.kind === "missing") return { status: "absent" };
  if (committed.kind === "unparsable") {
    return committed.raw.includes("verifierReviewedThrough")
      ? { status: "unusable", declared: "", reason: "malformed" }
      : { status: "absent" };
  }
  const raw = declaredBaseline(committed);
  if (raw === undefined) return { status: "absent" };
  if (typeof raw !== "string") {
    return { status: "unusable", declared: String(raw), reason: "malformed" };
  }
  const unusable = (reason: VerifierReviewBaselineReason): VerifierReviewBaseline => ({
    status: "unusable",
    declared: raw,
    reason,
  });
  const fmt = await gitEvidence(repoRoot, ["rev-parse", "--show-object-format"]);
  assertJudgedEvidence(fmt);
  if (fmt.exitCode !== 0) return unusable("unverifiable");
  const hexLen = fmt.stdout.trim() === "sha256" ? 64 : 40;
  if (!new RegExp(`^[0-9a-f]{${hexLen}}$`).test(raw)) return unusable("malformed");
  // The develop tip the baseline is judged against must still be the
  // fully-qualified local branch — a persisted digest from a bare-name
  // resolution, or a shadow ref, must not anchor the ancestry check.
  const tip = await gitEvidence(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    "refs/heads/develop",
  ]);
  assertJudgedEvidence(tip);
  if (tip.exitCode !== 0 || tip.stdout.trim() !== developTip) return unusable("unverifiable");
  const peeled = await gitEvidence(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${raw}^{commit}`,
  ]);
  assertJudgedEvidence(peeled);
  if (peeled.exitCode === -1) return unusable("unverifiable");
  if (peeled.exitCode !== 0) return unusable("unknown");
  // A tag object peels to a DIFFERENT commit — never a stand-in.
  if (peeled.stdout.trim() !== raw) return unusable("not-a-commit");
  const anc = await gitEvidence(repoRoot, ["merge-base", "--is-ancestor", raw, developTip]);
  assertJudgedEvidence(anc);
  if (anc.exitCode === 1) return unusable("not-ancestor");
  if (anc.exitCode !== 0) return unusable("unverifiable");
  return { status: "applied", sha: raw };
}

/** `rev-list <rev>` as a set — null when the read fails (exempt nothing). */
async function ancestrySet(repoRoot: string, rev: string): Promise<Set<string> | null> {
  const r = await gitEvidence(repoRoot, ["rev-list", rev]);
  assertJudgedEvidence(r);
  if (r.exitCode !== 0) return null;
  return new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function singleParent(repoRoot: string, sha: string): Promise<string | null> {
  const r = await gitEvidence(repoRoot, ["rev-list", "--parents", "-n", "1", sha]);
  assertJudgedEvidence(r);
  if (r.exitCode !== 0) return null;
  const parts = r.stdout.trim().split(/\s+/);
  return parts.length === 2 && parts[0] === sha ? parts[1]! : null;
}

async function treeOf(repoRoot: string, sha: string): Promise<string | null> {
  const r = await gitEvidence(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${sha}^{tree}`,
  ]);
  assertJudgedEvidence(r);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

async function treeListing(repoRoot: string, sha: string): Promise<Map<string, string> | null> {
  const r = await gitEvidence(repoRoot, ["ls-tree", "-r", "-z", sha]);
  assertJudgedEvidence(r);
  if (r.exitCode !== 0) return null;
  const out = new Map<string, string>();
  for (const rec of r.stdout.split("\0")) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf("\t");
    if (tab <= 0) return null;
    out.set(rec.slice(tab + 1), rec.slice(0, tab));
  }
  return out;
}

/** Canonical JSON for doc comparison — key order never matters. */
function canonicalDoc(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalDoc).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalDoc(rec[k])}`)
      .join(",")}}`;
  }
  // NaN/±Infinity serialize as `null` and unsafe integers lose
  // precision — a doc carrying one never compares equal (no exemption).
  if (typeof v === "number" && (!Number.isFinite(v) || !Number.isSafeInteger(Math.trunc(v)))) {
    return `\u0000unfaithful:${Math.random()}`;
  }
  if (typeof v === "bigint") return `\u0000unfaithful:${Math.random()}`;
  return JSON.stringify(v ?? null);
}

function withoutBaseline(doc: Record<string, unknown> | null): string {
  if (doc === null) return "null";
  const push = pushSection(doc);
  if (push === undefined) return canonicalDoc(doc);
  const { verifierReviewedThrough: _drop, ...restPush } = push;
  return canonicalDoc({ ...doc, push: restPush });
}

/**
 * RFC-1643: the integrate-generated weakening record of a baseline-only
 * bump. In a `policy:` repository `push` is a contour key, so
 * `flow.integrate --accept-weakening` appends an EMPTY commit carrying
 * `X-Correctness-Weakening` on top of the bump — always a descendant of
 * the baseline it records. Exempt exactly that record: sole trailer
 * X-Correctness-Weakening, empty, single parent P, P single-parent, P
 * changes only forge.yaml, only `push.verifierReviewedThrough` differs,
 * and P sets it to the APPLIED baseline.
 */
async function isBaselineBumpRecord(
  repoRoot: string,
  hit: { sha: string; trailers: string[] },
  baseline: string,
): Promise<boolean> {
  if (hit.trailers.length !== 1 || hit.trailers[0] !== "X-Correctness-Weakening") return false;
  const p = await singleParent(repoRoot, hit.sha);
  if (p === null) return false;
  const [wTree, pTree] = await Promise.all([treeOf(repoRoot, hit.sha), treeOf(repoRoot, p)]);
  if (wTree === null || wTree !== pTree) return false;
  const pp = await singleParent(repoRoot, p);
  if (pp === null) return false;
  const [before, after] = await Promise.all([treeListing(repoRoot, pp), treeListing(repoRoot, p)]);
  if (before === null || after === null) return false;
  const changed = new Set<string>();
  for (const [path, entry] of after) if (before.get(path) !== entry) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  if (changed.size !== 1 || !changed.has("forge.yaml")) return false;
  const [docBefore, docAfter] = await Promise.all([
    readCommittedForgeDoc(repoRoot, pp),
    readCommittedForgeDoc(repoRoot, p),
  ]);
  if (docBefore.kind !== "doc" || docAfter.kind !== "doc") return false;
  if (declaredBaseline(docAfter) !== baseline) return false;
  if (declaredBaseline(docBefore) === baseline) return false;
  return withoutBaseline(docBefore.doc) === withoutBaseline(docAfter.doc);
}

/** RFC-1643: how far back FLOW-PUSH-17 walks forge.yaml-touching first-parent commits. */
const BASELINE_HISTORY_WINDOW = 64;

/** RFC-1643: one change of the parsed baseline value on develop's first-parent chain. */
export interface BaselineChange {
  commit: string;
  from: string;
  to: string;
}

/**
 * RFC-1643 (FLOW-PUSH-17 visibility): every change of the PARSED
 * `push.verifierReviewedThrough` value on develop's first-parent chain,
 * newest first — compared by value, never by text (a comment or a
 * re-quote that `-G` would match is not a change, and a decoy commit can
 * no longer pose as the bump). The walk covers the forge.yaml-touching
 * first-parent commits up to BASELINE_HISTORY_WINDOW and stops where the
 * key is absent (its introduction). `oldest` is the value at the window's
 * far end — `undefined` when the key was introduced inside the window, so
 * "newly exempted" is measured from a point a chain of session bumps
 * cannot move inside the window. Advisory — a failed read yields
 * `undefined`, never an exemption.
 */
async function baselineHistory(
  repoRoot: string,
  developTip: string,
): Promise<{ changes: BaselineChange[]; oldest: unknown } | undefined> {
  const r = await gitEvidence(repoRoot, [
    "log",
    "--first-parent",
    "--format=%H",
    "-n",
    String(BASELINE_HISTORY_WINDOW),
    developTip,
    "--",
    "forge.yaml",
  ]);
  assertJudgedEvidence(r);
  if (r.exitCode !== 0) return undefined;
  const commits = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (commits.length === 0 || !commits.every((c) => /^[0-9a-f]{40,64}$/.test(c))) {
    return undefined;
  }
  const valueAt = async (rev: string): Promise<string | undefined | null> => {
    const doc = await readCommittedForgeDoc(repoRoot, rev);
    if (doc.kind === "unverifiable" || doc.kind === "unparsable") return null;
    const v = declaredBaseline(doc);
    return v === undefined ? undefined : String(v);
  };
  const changes: BaselineChange[] = [];
  let current = await valueAt(commits[0]!);
  if (current === null) return undefined;
  for (const c of commits) {
    // History simplification: on the first-parent chain, `c^1` carries
    // the same forge.yaml as the next older listed commit.
    const before = await valueAt(`${c}^1`);
    if (before === null) return undefined;
    if (before !== current) {
      changes.push({ commit: c, from: before ?? "(absent)", to: current ?? "(absent)" });
    }
    current = before;
    if (current === undefined) return { changes, oldest: undefined };
  }
  return { changes, oldest: current };
}

export async function pushFlow(
  repoRoot: string,
  io: WorkspaceIO,
  opts: {
    digest: string;
    dryRun: boolean;
    now?: Date;
    acceptVerifierTrailers?: string;
    /** RFC-1638: force the full recount path — skip the persisted input-hash attestation. */
    recount?: boolean;
  },
): Promise<FlowPushData> {
  // These two reads go through gitEvidence — a refused channel (transport
  // lever or shape file in .git) throws here before the digest's own
  // diagnostic refuse can answer (CX-72/CX-76). Translate the throw into
  // the refusal it is.
  let common: Awaited<ReturnType<typeof commonGitDir>>;
  let primary: string;
  try {
    common = await commonGitDir(io, repoRoot);
    primary = await primaryWorktree(io, repoRoot);
  } catch (e) {
    // Only a refused repo surface converts to a refuse — a dead resolved
    // binary is a channel break, which must still reject loudly (R4-R2).
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(EVIDENCE_REFUSED_PREFIX)) throw e;
    return refuse(
      "FLOW-PUSH-13",
      `the evidence channel refused the repository surface — ${msg}`,
      "remove the transport/exec config lever or the .git shape file and re-run flow.push",
    );
  }

  // --- preflight -------------------------------------------------------------
  // RFC-1501: a dry-run never fetches — `git fetch origin --prune` rewrites
  // and prunes remote-tracking refs. It judges the digest exactly like
  // `flow.digest --no-fetch`; a real push still fetches first.
  // RFC-1638: a persisted reviewed digest attests in seconds when every
  // cheap input still matches (`observeDigestInputs` re-reads through the
  // judged channel — a verdict input, never bestEffort). Any drift, an
  // unprovable input, or --recount falls back to the full recount — the
  // FLOW-PUSH-02 contract byte-for-byte. A missing, unreadable or
  // payload-forged persisted digest refuses FLOW-PUSH-15: no weaker check
  // to silently downgrade to.
  let digest: FlowDigestData | null = null;
  let attestation: "input-hash" | "recount" = "recount";
  let digestComputedAt: string | undefined;
  // Attestation fields ride every refusal decided AFTER the digest loaded —
  // the audit trail always records how the quoted digest was validated.
  // RFC-1643: the baseline judgment rides every refusal decided after the
  // verifier scan ran (FLOW-PUSH-03/06/07…), not only the stop itself.
  const baselineDiags: Diagnostic[] = [];
  let verifierReviewBaseline: FlowPushData["verifierReviewBaseline"];
  const refuseChecked = (ruleId: string, message: string, fixHint?: string): FlowPushData => {
    const base = refuse(ruleId, message, fixHint);
    return {
      ...base,
      attestation,
      digestComputedAt,
      ...(verifierReviewBaseline !== undefined ? { verifierReviewBaseline } : {}),
      diagnostics: [...base.diagnostics, ...baselineDiags],
    };
  };
  if (!opts.recount) {
    const persisted = await loadPersistedDigest(io, common, opts.digest);
    if (persisted === "missing") {
      return refuse(
        "FLOW-PUSH-15",
        `no persisted digest ${opts.digest} under .git/forge/digests — the quoted id predates persistence or the forge state was cleaned; re-run flow.digest to record a fresh reviewed state`,
        "re-run flow.digest, review the new state and re-run flow.push --digest <id>",
      );
    }
    if (persisted === "unknown") {
      return refuse(
        "FLOW-PUSH-15",
        `the persisted digest ${opts.digest} is unreadable or carries an unknown schema — it cannot attest pushed state; re-run flow.digest to record a fresh reviewed state`,
        "re-run flow.digest and re-run flow.push --digest <id>",
      );
    }
    // Payload binding (RFC-1638 review round 1): the file is session-writable
    // like the journal, but unlike a journal `push` record it MINTS the push
    // payload — so the record must preimage the quoted id. Recomputing
    // digestId from the file's own fields means a forged payload needs a
    // 48-bit sha256 preimage, not a plausible-looking JSON.
    if (
      recomputePersistedDigestId(persisted) !== opts.digest ||
      persisted.digest.digestId !== opts.digest
    ) {
      return refuse(
        "FLOW-PUSH-15",
        `the persisted digest ${opts.digest} does not preimage the quoted id — the file is forged or corrupt; re-run flow.digest to record a fresh reviewed state`,
        "re-run flow.digest, review the new state and re-run flow.push --digest <id>",
      );
    }
    const inputs = await observeDigestInputs(repoRoot, io);
    if (inputs !== null && digestInputHash(inputs) === persisted.inputHash) {
      digest = persisted.digest;
      attestation = "input-hash";
      digestComputedAt = persisted.computedAt;
    }
  }
  if (digest === null) {
    digest = await collectDigest(repoRoot, io, { fetch: !opts.dryRun, persist: !opts.dryRun });
    digestComputedAt ??= new Date().toISOString();
  }
  const noOrigin = digest.diagnostics.find(
    (d) => d.ruleId === "FLOW-PUSH-01" && d.severity === "error",
  );
  if (noOrigin !== undefined) {
    return refuseChecked("FLOW-PUSH-01", noOrigin.message, "add an 'origin' remote first");
  }
  // Any other error-severity digest diagnostic blocks the push too — a
  // remote identity that cannot be proven (FLOW-PUSH-09: url.insteadOf
  // rewrite, pushurl/pushInsteadOf split) means the scanned remote is not
  // the pushed remote, and a failed fetch/ls-remote means the judged tips
  // are stale or planted (CX-62/CX-63).
  const blocking = digest.diagnostics.filter((d) => d.severity === "error");
  if (blocking.length > 0) {
    const first = blocking[0]!;
    return refuseChecked("FLOW-PUSH-10", first.message, first.fixHint);
  }
  // No remote-verification gate exists anymore: `fetched` is
  // structurally false because the evidence channel refuses every
  // transport — a session-authored remote can never supply trusted
  // evidence (CX-132), and FLOW-PUSH-11's stale-tip premise died with
  // it. The gate property it guarded is preserved by construction: the
  // trailer scan below always covers the whole local branch
  // (`remoteVerified` is never true), so nothing narrows the check on
  // remote-derived state.
  if (digest.digestId !== opts.digest) {
    return refuseChecked(
      "FLOW-PUSH-02",
      `the digest is stale — the current digestId is ${digest.digestId}, not ${opts.digest}`,
      `run flow.digest, review the new state and re-run flow.push --digest ${digest.digestId}`,
    );
  }

  // RFC-1616 (AC-6): verifier-trailer scan over the develop+main branches.
  // A commit carrying a verifier/audit trailer claims provenance the
  // session cannot self-certify — the operator must see those commits before
  // they leave the machine. `push.requireVerifierReview` defaults to true;
  // an explicit `false` opts the repository out (itself a judged key).
  // RFC-1643: both review keys are read from the COMMITTED forge.yaml at the
  // digest-reviewed develop tip — never the worktree (CX-34) and never HEAD,
  // which in a session worktree is an unintegrated branch. An unreadable or
  // missing committed config defaults to required (fail closed).
  const developTip = digest.develop.local;
  let committed: CommittedForgeDoc;
  try {
    committed =
      developTip === "" ? { kind: "missing" } : await readCommittedForgeDoc(repoRoot, developTip);
  } catch {
    // A throwing channel is unverifiable — review stays required and the
    // baseline exempts nothing (fail closed, as a diagnostic).
    committed = { kind: "unverifiable" };
  }
  const declaredReview =
    committed.kind === "doc" ? pushSection(committed.doc)?.["requireVerifierReview"] : undefined;
  const requireVerifierReview = declaredReview !== false;
  const scannedRanges: string[] = [];
  const verifierTrailerCommits = new Map<string, { sha: string; trailers: string[] }>();
  for (const [local, remote] of [
    [digest.develop.local, digest.develop.remote],
    [digest.main.local, digest.main.remote],
  ] as const) {
    // An unverified remote tip is a session-mutable tracking ref — planting
    // it at a trailer commit would take the commit out of the scan range
    // (CX-82: --dry-run's fetch:false path reported a false-clean preview).
    // The strictest honest range scans the whole local branch when the
    // remote was never contacted.
    const range = remote === null || !digest.remoteVerified ? local : `${remote}..${local}`;
    if (range === null || scannedRanges.includes(range)) continue;
    scannedRanges.push(range);
    const scan = await scanVerifierTrailers(repoRoot, io, range);
    if (scan === null) {
      return refuseChecked(
        "FLOW-PUSH-13",
        `the verifier-trailer scan over '${range}' is unverifiable — the push cannot prove which commits carry verifier/audit trailers`,
        "remove the evidence-channel refusal and re-run flow.push",
      );
    }
    for (const hit of scan) {
      verifierTrailerCommits.set(hit.sha, hit);
    }
  }
  const trailerHits = [...verifierTrailerCommits.values()].sort((a, b) =>
    a.sha.localeCompare(b.sha),
  );
  // RFC-1643: the committed review baseline — exemption is computed AFTER
  // the full scan, so the scan (batched or per-commit) never narrows and
  // `verifierTrailerCommits` keeps every hit.
  const exempt = new Set<string>();
  if (requireVerifierReview && trailerHits.length > 0) {
    const baseline =
      developTip === ""
        ? ({ status: "absent" } as const)
        : await resolveVerifierReviewBaseline(repoRoot, developTip, committed);
    let reason: VerifierReviewBaselineReason | undefined =
      baseline.status === "unusable" ? baseline.reason : undefined;
    const newlyExempted: string[] = [];
    let bumpedBy: string | undefined;
    let baselineChanges: BaselineChange[] = [];
    if (baseline.status === "applied") {
      // Positive membership: an under-reporting read can only shrink the
      // exemption, never widen it.
      const reviewed = await ancestrySet(repoRoot, baseline.sha);
      if (reviewed === null) {
        reason = "unverifiable";
      } else {
        for (const hit of trailerHits) {
          // A pseudo-hit means the scan could not read the commit — it
          // keeps blocking whatever its ancestry.
          if (hit.trailers.some((t) => t.startsWith("x-unverifiable"))) continue;
          if (reviewed.has(hit.sha) || (await isBaselineBumpRecord(repoRoot, hit, baseline.sha))) {
            exempt.add(hit.sha);
          }
        }
        if (exempt.size > 0) {
          const history = await baselineHistory(repoRoot, developTip);
          baselineChanges = history?.changes ?? [];
          bumpedBy = baselineChanges[0]?.commit;
          const prev =
            typeof history?.oldest === "string" && /^[0-9a-f]{40,64}$/.test(history.oldest)
              ? await ancestrySet(repoRoot, history.oldest)
              : null;
          for (const sha of exempt) if (prev === null || !prev.has(sha)) newlyExempted.push(sha);
          newlyExempted.sort();
          const changeLog =
            history === undefined
              ? "baseline history unreadable"
              : baselineChanges.length === 0
                ? `no value change in the last ${BASELINE_HISTORY_WINDOW} forge.yaml commits`
                : baselineChanges
                    .map(
                      (c) => `${c.commit.slice(0, 9)}: ${c.from.slice(0, 9)}→${c.to.slice(0, 9)}`,
                    )
                    .join("; ");
          baselineDiags.push({
            ruleId: "FLOW-PUSH-17",
            severity: "warning",
            message:
              `push.verifierReviewedThrough ${baseline.sha.slice(0, 9)} exempts ${exempt.size} ` +
              `verifier/audit trailer commit(s) from the review stop (${newlyExempted.length} newly ` +
              `exempted within the last ${BASELINE_HISTORY_WINDOW} forge.yaml commits; baseline changes: ${changeLog})`,
            fixHint:
              "confirm the baseline was moved by the operator after reviewing the listed commits (RFC-1643)",
          });
        }
      }
    }
    if (reason !== undefined) {
      const declared =
        baseline.status === "unusable"
          ? baseline.declared
          : baseline.status === "applied"
            ? baseline.sha
            : "";
      baselineDiags.push({
        ruleId: "FLOW-PUSH-16",
        severity: "warning",
        message: `push.verifierReviewedThrough${declared ? ` '${declared}'` : ""} is unusable (${reason}) — it exempts no trailer commit`,
        fixHint:
          "set it to a full, quoted commit sha reachable from refs/heads/develop in the committed forge.yaml (RFC-1643)",
      });
    }
    verifierReviewBaseline = {
      status: reason !== undefined ? "unusable" : baseline.status,
      ...(baseline.status === "unusable" && baseline.declared
        ? { declared: baseline.declared }
        : {}),
      ...(baseline.status === "applied" ? { declared: baseline.sha } : {}),
      ...(reason !== undefined ? { reason } : {}),
      exempted: [...exempt].sort(),
      newlyExempted,
      ...(bumpedBy !== undefined ? { bumpedBy } : {}),
      changes: baselineChanges,
    };
  }
  const blockingHits = trailerHits.filter((h) => !exempt.has(h.sha));
  if (blockingHits.length > 0 && requireVerifierReview) {
    if (!opts.acceptVerifierTrailers) {
      return {
        digestId: digest.digestId,
        attestation,
        digestComputedAt,
        pushed: false,
        refs: [],
        publications: [],
        superseded: [],
        retired: [],
        verifierTrailerCommits: trailerHits,
        ...(verifierReviewBaseline !== undefined ? { verifierReviewBaseline } : {}),
        diagnostics: [
          {
            ruleId: "FLOW-PUSH-08",
            severity: "error",
            message:
              `${blockingHits.length} commit(s) on the scanned local branches carry a verifier/audit trailer ` +
              `(the scan covers the whole branch — tracking refs cannot prove what is already pushed, CX-82) ` +
              `(${blockingHits.map((h) => `${h.sha.slice(0, 9)}[${h.trailers.join(",")}]`).join("; ")})` +
              (exempt.size > 0
                ? ` — ${exempt.size} more exempted by push.verifierReviewedThrough`
                : "") +
              (verifierReviewBaseline?.status === "unusable"
                ? ` — push.verifierReviewedThrough is unusable (${verifierReviewBaseline.reason ?? "unverifiable"}) and exempts nothing`
                : "") +
              ` — verifier evidence must be reviewed before it leaves the machine`,
            fixHint:
              "review the commits, then re-run with " +
              '--accept-verifier-trailers "<reason>" — or record the review as a committed ' +
              "push.verifierReviewedThrough baseline (operator only, RFC-1643), or opt the " +
              "repository out with push.requireVerifierReview: false in forge.yaml",
          },
          ...baselineDiags,
        ],
      };
    }
  }

  for (const [branch, remote] of [
    ["develop", digest.develop.remote],
    ["main", digest.main.remote],
  ] as const) {
    if (remote === null) continue;
    // RFC-1643: fully qualified — a shadow `refs/tags/<branch>` must not
    // stand in for the local branch.
    const ancestor = await gitEvidence(repoRoot, [
      "merge-base",
      "--is-ancestor",
      remote,
      `refs/heads/${branch}`,
    ]);
    assertJudgedEvidence(ancestor);
    if (ancestor.exitCode !== 0) {
      return refuseChecked(
        "FLOW-PUSH-03",
        `origin/${branch} is not an ancestor of ${branch} — someone pushed elsewhere`,
        "fetch, inspect the divergence and reconcile before pushing",
      );
    }
  }

  const { lines } = await discoverReleaseLines(repoRoot, io);

  // Publications (RFC-1503/R13-C): candidates = package-line tags pushed
  // in this run only. The journal is session-writable, so a `push` record
  // can suppress a tag (hiding it from digest.tags) but never mint one —
  // "pushed but unpublished" is unverifiable locally and stays out of the
  // candidate set entirely. Per line only the highest version is
  // attempted — lower ones supersede, retired tags drop.
  const journalEvents = await readJournal(io, common);
  const publishedTags = new Set(
    journalEvents.filter((e) => e.event === "publish").map((e) => e.branch),
  );
  const retiredTags = new Set(
    journalEvents.filter((e) => e.event === "publish-retired").map((e) => e.branch),
  );

  // RFC-1638: `push` records suppress tags at push-PLANNING time — the
  // persisted digest's tags were suppressed at digest time, and records
  // appended meanwhile must hide their tags here too. Suppression is
  // monotonic (a record can only hide, R13-C), so re-filtering the digest's
  // list is idempotent on the recount path.
  const pushedNow = new Set<string>();
  for (const e of journalEvents) {
    if (e.event !== "push") continue;
    for (const token of e.detail.split(/[^A-Za-z0-9._/@-]+/)) {
      if (token.length > 0) pushedNow.add(token);
    }
  }
  const effectiveTags = digest.tags.filter((t) => !pushedNow.has(t));

  const publicationTags = new Map<string, ReleaseLine>();
  const addCandidate = (tag: string, lineId: string | null): void => {
    const line =
      (lineId === null ? null : lines.find((l) => l.id === lineId)) ?? lineForTag(lines, tag);
    if (line !== null && line.id !== "repo") publicationTags.set(tag, line);
  };
  for (const tag of effectiveTags) addCandidate(tag, null);

  const baselineSkipped: PublicationRow[] = [];
  const planCandidates: PublicationPlanEntry[] = [];
  for (const [tag, line] of [...publicationTags.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const level = await tagAnnotationLevel(repoRoot, io, tag);
    if (level === "baseline") {
      baselineSkipped.push({
        tag,
        line: line.id,
        status: "skipped-baseline",
        dest: null,
        verify: null,
        reconciled: false,
        destHead: null,
      });
    } else {
      planCandidates.push({ tag, line: line.id });
    }
  }
  let plan = planPublications(planCandidates, publishedTags, retiredTags, (tag, lineId) =>
    versionOfTag(lines, tag, lineId),
  );
  let publishable: Array<{ tag: string; line: ReleaseLine }> = plan.attempt.map((p) => ({
    tag: p.tag,
    line: lines.find((l) => l.id === p.line)!,
  }));

  for (const { line } of publishable) {
    const dir = line.paths[0]!;
    if (!(await markerIsValid(join(primary, dir, "forge.generated.yaml"), io))) {
      return refuseChecked(
        "FLOW-PUSH-06",
        `package line ${line.id} has no valid forge.generated.yaml in ${dir} — it must not be published`,
        "re-run flow.install to restore the marker, or remove the line's tags",
      );
    }
  }

  const extractBin = join(primary, "node_modules", ".bin", "repo-extract");
  if (publishable.length > 0 && !(await io.exists(extractBin))) {
    return refuseChecked(
      "FLOW-PUSH-07",
      `${extractBin} is missing while ${publishable.length} tag(s) wait to publish`,
      "install the workspace dependencies so repo-extract is linked",
    );
  }

  // Sha-pinned refspecs — the push ships exactly the reviewed tips; a local
  // branch that moved since the digest stays local instead of sneaking in.
  // Refspecs cover the effective tag set in full (R13-C): every tag this
  // run will treat as publishable is pushed in the same atomic push — a
  // fabricated journal `push` record can never make an unpushed tag look
  // remote.
  const pushedTagNames = effectiveTags;
  const refspecs = [
    `${digest.develop.local}:refs/heads/develop`,
    `${digest.main.local}:refs/heads/main`,
    ...pushedTagNames.map((t) => `refs/tags/${t}:refs/tags/${t}`),
  ];

  if (opts.dryRun) {
    return {
      digestId: digest.digestId,
      attestation,
      digestComputedAt,
      fetched: digest.fetched,
      pushed: false,
      refs: refspecs,
      publications: [
        ...baselineSkipped,
        ...publishable.map((p): PublicationRow => ({
          tag: p.tag,
          line: p.line.id,
          status: "pending",
          dest: null,
          verify: null,
          reconciled: false,
          destHead: null,
        })),
      ],
      superseded: plan.superseded.map((s) => ({
        tag: s.tag,
        by: s.by ?? plan.attempt.find((a) => a.line === s.line)?.tag ?? "",
      })),
      retired: [...retiredTags].sort((a, b) => a.localeCompare(b)),
      verifierTrailerCommits: trailerHits,
      verifierTrailersAccepted: opts.acceptVerifierTrailers,
      ...(verifierReviewBaseline !== undefined ? { verifierReviewBaseline } : {}),
      diagnostics: [...digest.diagnostics, ...baselineDiags],
    };
  }

  // --- push ------------------------------------------------------------------
  const hasRefs = digest.develop.ahead > 0 || digest.main.ahead > 0 || pushedTagNames.length > 0;
  const journalWarnings: string[] = [];
  let pushed = false;
  if (hasRefs) {
    // Push rides the session channel — credential helpers and url.insteadOf
    // live in user config the scrubbed evidence env intentionally drops.
    const push = await git(repoRoot, io, ["push", "--atomic", "origin", ...refspecs], {
      env: { FORGE_FLOW_OP: "push" },
    });
    if (push.exitCode !== 0) {
      return {
        digestId: digest.digestId,
        attestation,
        digestComputedAt,
        fetched: digest.fetched,
        pushed: false,
        refs: refspecs,
        publications: [],
        superseded: [],
        retired: [...retiredTags].sort((a, b) => a.localeCompare(b)),
        verifierTrailerCommits: trailerHits,
        verifierTrailersAccepted: opts.acceptVerifierTrailers,
        ...(verifierReviewBaseline !== undefined ? { verifierReviewBaseline } : {}),
        diagnostics: [
          ...baselineDiags,
          {
            ruleId: "FLOW-PUSH-04",
            severity: "error",
            message: `git push --atomic failed — nothing was updated: ${push.stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}`,
            fixHint: "inspect the remote error, reconcile, and re-run with a fresh digest",
          },
        ],
      };
    }
    pushed = true;
    try {
      await appendJournal(io, common, {
        event: "push",
        branch: "develop",
        sha: digest.develop.local,
        base: digest.develop.remote ?? undefined,
        detail: pushedTagNames.join(" "),
      });
    } catch (error) {
      journalWarnings.push(
        `push journal record could not be appended — pushed tags ${pushedTagNames.join(", ") || "(none)"} stay in digest.tags and will be re-pushed on the next run: ${String(error)}`,
      );
    }
  }

  // --- publications ------------------------------------------------------------
  // RFC-1503 review r1 F-5: re-read the journal after the push — a retire or
  // supersede record appended meanwhile must drop the tag from this run's
  // attempts. The window can only be narrowed, not closed: appendJournal
  // takes no push-spanning lock.
  const freshJournal = await readJournal(io, common);
  const freshPublished = new Set(
    freshJournal.filter((e) => e.event === "publish").map((e) => e.branch),
  );
  const freshRetired = new Set(
    freshJournal.filter((e) => e.event === "publish-retired").map((e) => e.branch),
  );
  const freshSuperseded = new Set(
    freshJournal.filter((e) => e.event === "publish-superseded").map((e) => e.branch),
  );
  if (freshPublished.size !== publishedTags.size || freshRetired.size !== retiredTags.size) {
    for (const tag of freshPublished) publishedTags.add(tag);
    for (const tag of freshRetired) retiredTags.add(tag);
    plan = planPublications(
      planCandidates.filter((c) => !freshSuperseded.has(c.tag)),
      publishedTags,
      retiredTags,
      (tag, lineId) => versionOfTag(lines, tag, lineId),
    );
    publishable = plan.attempt.map((p) => ({
      tag: p.tag,
      line: lines.find((l) => l.id === p.line)!,
    }));
  } else {
    plan = {
      attempt: plan.attempt,
      superseded: plan.superseded.filter((s) => !freshSuperseded.has(s.tag)),
    };
  }

  const publications: PublicationRow[] = [...baselineSkipped];
  const supersededOut: Array<{ tag: string; by: string }> = [];
  // Digest-level warnings (a stale-ref fetch notice, remote oddities) must
  // surface in the push output — a warning that never left collectDigest
  // was the invisible half of CX-63.
  const diagnostics: Diagnostic[] = [
    ...digest.diagnostics,
    ...baselineDiags,
    ...journalWarnings.map((message): Diagnostic => ({
      ruleId: "FLOW-07",
      severity: "warning",
      message,
    })),
  ];

  const recordSuperseded = async (tag: string, by: string): Promise<void> => {
    try {
      await appendJournal(io, common, {
        event: "publish-superseded",
        branch: tag,
        sha: "",
        detail: by,
      });
      supersededOut.push({ tag, by });
    } catch (error) {
      diagnostics.push({
        ruleId: "FLOW-07",
        severity: "warning",
        message: `publish-superseded record for ${tag} could not be appended — the tag stays pending and will be re-evaluated on the next push: ${String(error)}`,
      });
    }
  };

  // Superseded on sight — a pending tag at or below the line's newest
  // published version is never extracted (RFC-1503 AC-3).
  for (const sup of plan.superseded) {
    if (sup.by !== null) await recordSuperseded(sup.tag, sup.by);
  }
  // Shadowed candidates — superseded only once their line's highest tag
  // actually publishes (RFC-1503 AC-2).
  const shadowed = new Map<string, string[]>();
  for (const sup of plan.superseded) {
    if (sup.by === null) {
      const list = shadowed.get(sup.line) ?? [];
      list.push(sup.tag);
      shadowed.set(sup.line, list);
    }
  }

  for (const { tag, line } of publishable) {
    const row = await publishTag(primary, io, { line, tag });
    publications.push(row);
    if (row.status === "failed") {
      diagnostics.push({
        ruleId: "FLOW-PUSH-05",
        severity: "error",
        message: `publication of ${tag} (${line.id}) failed: ${row.error ?? "unknown"}`,
        fixHint:
          "fix the extract or destination; the tag is already on origin and suppressed from digest.tags — republish it via repo-extract directly or retire it with flow.publication.retire",
      });
      continue;
    }
    if (row.status === "published") {
      try {
        await appendJournal(io, common, {
          event: "publish",
          branch: tag,
          sha: row.destHead ?? "",
          detail: row.dest ?? "",
        });
      } catch (error) {
        diagnostics.push({
          ruleId: "FLOW-07",
          severity: "warning",
          message: `publish journal record for ${tag} could not be appended — the publication went out but has no local record; the tag stays suppressed from digest.tags: ${String(error)}`,
        });
      }
      for (const low of shadowed.get(line.id) ?? []) {
        await recordSuperseded(low, tag);
      }
    }
  }

  return {
    digestId: digest.digestId,
    attestation,
    digestComputedAt,
    fetched: digest.fetched,
    pushed,
    refs: refspecs,
    publications,
    superseded: supersededOut,
    retired: [...freshRetired].sort((a, b) => a.localeCompare(b)),
    verifierTrailerCommits: trailerHits,
    verifierTrailersAccepted: opts.acceptVerifierTrailers,
    ...(verifierReviewBaseline !== undefined ? { verifierReviewBaseline } : {}),
    diagnostics,
  };
}

export async function runFlowPush(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowPushData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io: WorkspaceIO = resolveIo(context.io);
  await requireGit(io);

  // Boundary root resolution: a session `GIT_DIR`/`GIT_WORK_TREE` must not
  // point the whole push surface at a planted repository (CX-51 class).
  const repoRoot = await verifierTopLevel(workspaceRoot);
  if (repoRoot === null) {
    throw new Error("flow.push must run inside a git repository");
  }

  const digestFlag = typeof input.flags["digest"] === "string" ? input.flags["digest"] : "";
  if (digestFlag.length === 0) {
    return {
      data: refuse(
        "FLOW-PUSH-02",
        "--digest <id> is required — run flow.digest first and quote its digestId",
      ),
      exitCode: 1,
      summary: "[flow.push] missing --digest",
    };
  }

  const acceptVerifierTrailers =
    typeof input.flags["accept-verifier-trailers"] === "string"
      ? input.flags["accept-verifier-trailers"].trim()
      : "";
  if (
    input.flags["accept-verifier-trailers"] !== undefined &&
    acceptVerifierTrailers.length === 0
  ) {
    return {
      data: refuse(
        "FLOW-PUSH-08",
        "--accept-verifier-trailers requires a non-empty reason — the operator must state why the trailers are trusted",
      ),
      exitCode: 1,
      summary: "[flow.push] empty --accept-verifier-trailers reason",
    };
  }

  let data: FlowPushData;
  try {
    data = await pushFlow(repoRoot, io, {
      digest: digestFlag,
      dryRun: input.flags["dry-run"] === true,
      acceptVerifierTrailers: acceptVerifierTrailers || undefined,
      recount: input.flags["recount"] === true,
    });
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      data = refuse("FLOW-07", error.message);
    } else {
      throw error;
    }
  }
  const errors = data.diagnostics.filter((d) => d.severity === "error");
  const publishedCount = data.publications.filter((p) => p.status === "published").length;

  if (outputFormat === "pretty") {
    for (const d of data.diagnostics) {
      if (d.severity === "error") logger.error(`  ${d.ruleId}: ${d.message}`);
      else logger.warn(`  ${d.ruleId}: ${d.message}`);
    }
    if (data.pushed) {
      logger.info(`  pushed: ${data.refs.join(", ")}`);
    }
    for (const pub of data.publications) {
      if (pub.status === "published") {
        logger.info(`  published ${pub.tag} → ${pub.dest}${pub.reconciled ? " (reconciled)" : ""}`);
      } else if (pub.status === "skipped-baseline") {
        logger.info(`  skipped baseline tag ${pub.tag}`);
      } else if (pub.status === "pending") {
        logger.info(`  would publish ${pub.tag} (dry-run)`);
      }
    }
    for (const sup of data.superseded) {
      logger.info(`  superseded ${sup.tag} by ${sup.by}`);
    }
  }

  return {
    data,
    exitCode: errors.length > 0 ? 1 : 0,
    summary:
      input.flags["dry-run"] === true
        ? `[flow.push] dry-run — ${data.refs.length} ref(s), ${data.publications.length} publication candidate(s)`
        : data.pushed || publishedCount > 0
          ? `[flow.push] pushed ${data.refs.length} ref(s), ${publishedCount} publication(s)`
          : `[flow.push] refused — ${errors.length} error(s)`,
  };
}
