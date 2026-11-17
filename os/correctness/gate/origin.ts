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
  <item>RFC-1615: wire range derivation into unreadable-reads, blob-only path reads, suppress unsupported anchor-removed</item>
  <item>RFC-1615: close RFC-1615 round-14 counterexamples — binding adds, base-side rfc namespace, governed acceptance provenance, unreadable listings</item>
  <item>RFC-1615: close RFC-1615 round-15 counterexamples — live rfcsDir key, base-anchored governing-reference resolution, judged compassDocs</item>
  <item>RFC-1615: harden round-15 observations — judge invariantsFile, parity rfc scope, strip binding keys, drop dead readHeadSide</item>
  <item>RFC-1615: close round-16 counterexamples — root-first rfc parity, rfcsDir dot, prune emptied strip containers</item>
  <history>RFC-1580, RFC-1615</history>
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
  const listing = await repo.listing(
    ["ls-tree", "-r", "-z", "--name-only", head, "--", normalizeRelPath(dir)],
    `ls-tree ${dir}`,
  );
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
export async function rfcPath(
  repo: GateRepo,
  head: string,
  rfcsDir: string,
  rfcId: string,
): Promise<string | null> {
  const listing = await repo.listing(
    ["ls-tree", "-r", "-z", "--name-only", head, "--", normalizeRelPath(rfcsDir)],
    `ls-tree ${rfcsDir}`,
  );
  const prefix = `${rfcId.toLowerCase()}-`;
  // Parity with the worktree `findRfcFile` (references.ts): the RFC lives
  // directly under rfcsDir or somewhere inside its `archive/` subtree —
  // never in an arbitrary sibling subdirectory (RFC-1615 review O-3).
  // `.` as rfcsDir means the repo root itself — `ls-tree` paths carry no
  // leading "./" (CX-114). A root-level match wins over an archive duplicate
  // (CX-113): ls-tree lists subtrees first, findRfcFile checks the root first.
  const dirNorm = normalizeRelPath(rfcsDir);
  const root = dirNorm === "." || dirNorm === "" ? "" : `${dirNorm}/`;
  const matches = (listing ?? "").split("\0").filter((l) => {
    if (!l.endsWith(".md") || (root !== "" && !l.startsWith(root))) return false;
    const inner = l.slice(root.length);
    const inScope = !inner.includes("/") || inner.startsWith("archive/");
    return inScope && l.split("/").pop()!.startsWith(prefix);
  });
  return (
    matches.find((l) => !l.slice(root.length).includes("/")) ??
    matches.find((l) => l.slice(root.length).startsWith("archive/")) ??
    null
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
  // `=== "yes"`: an unreadable history must not promote to verified — the
  // flag refuses elsewhere, but the bundle's origin claim stays honest.
  if ((await repo.lastTouchVerifier(head, checkFile)) === "yes") {
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
      const range = await resolveImplementationRange(repo.git, rel, (l) =>
        repo.unreadableReads.push(l),
      );
      // The acceptance must predate the integration base — a session cannot
      // accept (or create) the governing RFC together with its own test.
      // merge-base exit 1 is the "not an ancestor" verdict, not a failure —
      // only other codes flag (same class as `git grep` exit 1, CX-67).
      const acceptedBeforeBase =
        range.base !== null &&
        opts.integrationBase !== undefined &&
        (await repo.exitCode(
          ["merge-base", "--is-ancestor", range.base, opts.integrationBase],
          `merge-base --is-ancestor ${range.base.slice(0, 9)}`,
          [0, 1],
        )) === 0;
      if (range.base && acceptedBeforeBase) {
        // `status: accepted` is text any commit can write — the transition
        // must come from a GOVERNED commit: `X-RFC: <id>` (ecosystem.commit /
        // mission commit convention) or the verifier trailer pair. A plain
        // session commit cannot mint a requirement oracle (CX-79) — parity
        // with the review-record path, which demands trailer provenance.
        const acceptBody = await repo.commitBody(range.base);
        const governed =
          acceptBody !== null &&
          (hasVerifierTrailers(acceptBody) ||
            new RegExp(`^X-RFC:\\s*${rfcId}\\s*$`, "mi").test(acceptBody));
        const atAccept = governed ? await repo.blob(range.base, checkFile) : null;
        const now = governed ? await repo.blob(head, checkFile) : null;
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
