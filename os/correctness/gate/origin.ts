/*
<MODULE_CONTRACT>
<purpose>RFC-1580: oracle origin from git only — `verified` (the last commit
touching the check file carries the RFC-1333 verifier trailer pair, or a
committed `forge/oracle-review@1` record names the check with its current
sha256 and `verdict: pass`), `requirement` (an `rfc-ac` / `fixed-input`
entry whose check file is byte-identical to its state at the governing RFC's
`accepted` commit, RFC-1330 range), `self` (everything else). A `self`
oracle never covers an entry.</purpose>
<non-goals>
  <item>No second origin derivation — RFC-1330 `resolveImplementationRange` and `hasVerifierTrailers` are reused.</item>
  <item>Never writes review records or trailers — only the clean-context verifier workflow commits them.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1580: initial origin derivation.</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <item>RFC-1580: close review REVIEW-CODE-2026-11-13-04 findings

F1 bootstrap degrade only on an exact unknown-command stderr line with no JSON; F2 review records count only from a verifier-trailer commit naming them; F3 any frozen substrate change or dropped capture is a weakening, declared L3 needs loaded captures; F4 requirement origin needs acceptance before --base; F5 anchor events only for L2+ runs; F6 proof oracles via proof.check only, non-self; F7 bundle naming; F8/F9 limitations; F10 every anchor copy; F11 base entry refs; F12 unreadable base manifest refuses; F13 dirty worktree warning; F14 source/statement diffs; F15 process-group kill; F16 run root cleanup; F20 review dir stripped, blob hashes. Regression tests for spoofing, plain-commit review, L3, requirement origin, rewording, timeout, formal tier, rebind, real-gate pass, accept-weakening. DEV-1..DEV-6 recorded in the RFC.</item>
</CHANGE_SUMMARY>
*/

import { parse as parseYaml } from "yaml";

import { hasVerifierTrailers, resolveImplementationRange } from "../../rfc/verification-origin.ts";
import { normalizeCheckRef, normalizeRelPath } from "../workspace.ts";
import { sha256, type GateRepo } from "./repo.ts";
import { oracleReviewSchema, type OracleOrigin } from "./types.ts";

export interface ReviewedOracle {
  check: string;
  sha256: string;
  record: string;
}

/** Passing oracle rows from review records committed at `head` under `dir`. */
export async function readReviewRecords(
  repo: GateRepo,
  head: string,
  dir: string,
): Promise<ReviewedOracle[]> {
  const listing = await repo.git.run([
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    head,
    "--",
    normalizeRelPath(dir),
  ]);
  const out: ReviewedOracle[] = [];
  for (const rel of (listing ?? "").split("\0").filter((l) => /\.ya?ml$/.test(l))) {
    const text = await repo.show(head, rel);
    if (!text) continue;
    // A record counts only when the verifier workflow committed it: the last
    // commit touching it carries the trailer pair and its X-Verifier-Report
    // names this very record (so it also surfaces in flow.digest).
    const last = await repo.lastCommitBody(head, rel);
    if (!last || !hasVerifierTrailers(last.body)) continue;
    const reported = /^X-Verifier-Report:\s*(\S+)\s*$/m.exec(last.body)?.[1];
    if (!reported || normalizeRelPath(reported) !== normalizeRelPath(rel)) continue;
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch {
      continue;
    }
    const parsed = oracleReviewSchema.safeParse(doc);
    if (!parsed.success || parsed.data.verdict !== "pass") continue;
    for (const o of parsed.data.oracles) {
      if (o.verdict === "pass")
        out.push({ check: normalizeCheckRef(o.check), sha256: o.sha256, record: rel });
    }
  }
  return out;
}

export interface OriginResult {
  origin: OracleOrigin;
  /** True when `verified` came from the verifier trailer path (tier high requires it). */
  viaTrailer: boolean;
  detail: string;
}

/** Find the RFC file for `RFC-NNNN` in rfcsDir or its archive subtree at `head`. */
async function rfcPath(
  repo: GateRepo,
  head: string,
  rfcsDir: string,
  rfcId: string,
): Promise<string | null> {
  const listing = await repo.git.run([
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    head,
    "--",
    normalizeRelPath(rfcsDir),
  ]);
  const prefix = `${rfcId.toLowerCase()}-`;
  return (
    (listing ?? "")
      .split("\0")
      .find((l) => l.endsWith(".md") && l.split("/").pop()!.startsWith(prefix)) ?? null
  );
}

export async function deriveOrigin(opts: {
  repo: GateRepo;
  head: string;
  check: string;
  source: string;
  ref: string | null;
  rfcsDir: string;
  reviews: ReviewedOracle[];
  checkFile: string | null;
  /** The develop tip the session integrates into (requirement origin needs acceptance before it). */
  integrationBase?: string;
}): Promise<OriginResult> {
  const { repo, head, checkFile } = opts;
  if (!checkFile) return { origin: "self", viaTrailer: false, detail: "check has no file target" };
  const content = await repo.show(head, checkFile);
  if (content === null)
    return { origin: "self", viaTrailer: false, detail: `${checkFile} is not committed at HEAD` };
  if (await repo.lastTouchIsVerifier(head, checkFile)) {
    return {
      origin: "verified",
      viaTrailer: true,
      detail: "last commit carries the verifier trailer pair",
    };
  }
  const digest = sha256(content);
  const review = opts.reviews.find(
    (r) => r.check === normalizeCheckRef(opts.check) && r.sha256 === digest,
  );
  if (review)
    return { origin: "verified", viaTrailer: false, detail: `oracle review ${review.record}` };
  if ((opts.source === "rfc-ac" || opts.source === "fixed-input") && opts.ref) {
    const rfcId = /^(RFC-\d{4})\//.exec(opts.ref)?.[1];
    // Resolve the RFC at the integration base: a session-added duplicate file must not win.
    const rel = rfcId
      ? await rfcPath(repo, opts.integrationBase ?? head, opts.rfcsDir, rfcId)
      : null;
    if (rel) {
      const range = await resolveImplementationRange(repo.git, rel);
      // The acceptance must predate the integration base — a session cannot
      // accept (or create) the governing RFC together with its own test.
      const acceptedBeforeBase =
        range.base !== null &&
        opts.integrationBase !== undefined &&
        (await repo.git.run(["merge-base", "--is-ancestor", range.base, opts.integrationBase])) !==
          null;
      if (range.base && acceptedBeforeBase) {
        const atAccept = await repo.blob(range.base, checkFile);
        const now = await repo.blob(head, checkFile);
        if (atAccept !== null && atAccept === now) {
          return {
            origin: "requirement",
            viaTrailer: false,
            detail: `identical to ${rfcId} accepted commit ${range.base.slice(0, 9)}`,
          };
        }
      }
    }
  }
  return {
    origin: "self",
    viaTrailer: false,
    detail: "written or changed by the implementing session with no review record",
  };
}
