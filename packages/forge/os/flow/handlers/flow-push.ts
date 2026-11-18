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
  <item>RFC-1616: close RFC-1616 r4 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r5 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r7 trust-boundary counterexamples

Independent clean-context verification (round 7, candidate d2f270ad6)
returned REFUTED with eleven live counterexamples against the
r6-hardened evidence channel — this commit closes all nine root causes.

- remote.<name>.fetch is value-judged: only the clone-default
  +?refs/heads/*:refs/remotes/<name>/* shape stays KEEP, because git
  UNIONs configured refspecs with the pinned fetch argv and a session
  spec writes arbitrary local refs inside the trusted fetch (CX-94).
  remote.<name>.tagopt|promirror|followremotehead|prunetags|
  skipfetchall|mirror move to REFUSE for the same reason.
- Alternates/shape comment lexing is col-0 `#` only — git's parser does
  not treat whitespace-led `#` as a comment, so `   # forged` is a real
  alternates path the shape check must count (CX-95).
- config reads forbid the alternate-source selectors --file/-f, --blob,
  --worktree (reaches config.worktree even under the disabled-extension
  pin), --system/--global, --default and --includes, plus the
  write-action spellings, on both the evidence and shared read-only
  tables (CX-96).
- verifierGit judges fabrication argv on the runner/policy channel:
  @{...}, -g, --reflog, --walk-reflogs and --fork-point return
  EVIDENCE-REFUSED before the spawn — policy.digest --base 'HEAD@{0}'
  can no longer verify an unattested advance (CX-97).
- --use-bitmap-index/--test-bitmap are forbidden on rev-list/log in
  both tables — the flag opts the trusted walk into the session-
  writable pack bitmap cache the commitGraph/MIDX pins closed (CX-98).
- for-each-ref/show-ref/ls-remote forbid --stdin and --exclude-existing
  on both tables — they block on input the no-stdin spawn never
  supplies (CX-101).
- The workflow-adoption heredoc lexer is bash-faithful: openers are
  scanned on the raw line before the # comment strip (quoted-#
  delimiters, CX-99a), bare delimiters accept digits/./- (CX-99b), and
  the terminator match is strict — << wants the delimiter alone, <<-/
  <<~ skip leading tabs only (CX-100).
- Trailer scans read %e beside %(trailers): a commit declaring a
  non-UTF-8 encoding header recodes every trusted message read, so the
  digest trail and the push-time scan flag it as unverifiable and the
  policy attestation scan skips it (CX-102).

Probe premise updates for the tightened contract: CX-61's decoy
remote.origin.fetch (cx4 and cx5 R5-R1) now asserts the wholesale
EVIDENCE-REFUSED plus FLOW-PUSH-13 refuse — strictly stronger than the
decoy-namespace guard it replaces. The independent r7 probe file and
acceptance report land in the follow-up port commit.</item>
  <item>RFC-1616: close RFC-1616 r12 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r13 trust-boundary counterexamples</item>
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
import { collectDigest, lineForTag, versionOfTag } from "../digest.ts";
import { git, gitEvidence, parseGitTrailers, requireGit, verifierTopLevel } from "../git.ts";
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
 * audit trailer. Reads are delimiter-free: commit SHAs enumerate via
 * `rev-list` (hex-only output) and each commit's trailers arrive through
 * git's OWN `%(trailers:only)` parser — \x1e framing cannot hide a record
 * (CX-33), and `x-verifier-report:`/`X-Verifier-Report :` spellings count
 * exactly as `git interpret-trailers` counts them (CX-60). The channel is
 * `gitEvidence`: session GIT_* variables and refs/replace cannot redirect
 * or substitute what the scan sees (CX-48).
 */
async function scanVerifierTrailers(
  repoRoot: string,
  io: WorkspaceIO,
  range: string,
): Promise<Array<{ sha: string; trailers: string[] }>> {
  const list = await gitEvidence(repoRoot, ["rev-list", range]);
  if (list.exitCode !== 0) return [];
  const wanted = new Set(VERIFIER_TRAILERS.map((t) => t.toLowerCase()));
  const canonical = new Map(VERIFIER_TRAILERS.map((t) => [t.toLowerCase(), t]));
  const hits: Array<{ sha: string; trailers: string[] }> = [];
  for (const sha of list.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)) {
    // `%e` rides along — a commit declaring a non-default `encoding:`
    // header RECODES this very output, so %(trailers) over it is already
    // garbage: the header lives in the object and no -c pin reaches it
    // (CX-102). An encoded commit's trailers are unverifiable — flag it.
    const parsed = await gitEvidence(repoRoot, [
      "log",
      "-1",
      "--format=%(trailers:only,separator=%x00)%x00%e",
      sha,
    ]);
    if (parsed.exitCode !== 0) continue;
    const parsedParts = parsed.stdout.split("\x00");
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
    // safe, CX-23). `%s` is one line — no delimiter to smuggle.
    const subj = await gitEvidence(repoRoot, ["log", "-1", "--format=%s", sha]);
    if (subj.exitCode === 0) {
      const m = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(subj.stdout.trim());
      if (m) {
        const c = canonical.get(m[1]!.trim().toLowerCase());
        if (c && m[2]!.trim().length > 0) found.add(c);
      }
    }
    if (found.size > 0) hits.push({ sha, trailers: [...found].sort() });
  }
  return hits;
}

export async function pushFlow(
  repoRoot: string,
  io: WorkspaceIO,
  opts: { digest: string; dryRun: boolean; now?: Date; acceptVerifierTrailers?: string },
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
  const digest = await collectDigest(repoRoot, io, { fetch: !opts.dryRun });
  const noOrigin = digest.diagnostics.find(
    (d) => d.ruleId === "FLOW-PUSH-01" && d.severity === "error",
  );
  if (noOrigin !== undefined) {
    return refuse("FLOW-PUSH-01", noOrigin.message, "add an 'origin' remote first");
  }
  // Any other error-severity digest diagnostic blocks the push too — a
  // remote identity that cannot be proven (FLOW-PUSH-09: url.insteadOf
  // rewrite, pushurl/pushInsteadOf split) means the scanned remote is not
  // the pushed remote, and a failed fetch/ls-remote means the judged tips
  // are stale or planted (CX-62/CX-63).
  const blocking = digest.diagnostics.filter((d) => d.severity === "error");
  if (blocking.length > 0) {
    const first = blocking[0]!;
    return refuse("FLOW-PUSH-10", first.message, first.fixHint);
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
    return refuse(
      "FLOW-PUSH-02",
      `the digest is stale — the current digestId is ${digest.digestId}, not ${opts.digest}`,
      `run flow.digest, review the new state and re-run flow.push --digest ${digest.digestId}`,
    );
  }

  // RFC-1616 (AC-6): verifier-trailer scan over the unpushed develop+main
  // range. A commit carrying a verifier/audit trailer claims provenance the
  // session cannot self-certify — the operator must see those commits before
  // they leave the machine. `push.requireVerifierReview` defaults to true;
  // an explicit `false` opts the repository out (itself a judged key).
  // The declaration is read from the COMMITTED forge.yaml (HEAD) — a dirty
  // worktree opt-out must not take effect unjudged (CX-34); an unreadable or
  // missing committed config defaults to required (fail closed).
  let declared: boolean | undefined;
  try {
    const show = await gitEvidence(repoRoot, ["show", "HEAD:forge.yaml"]);
    if (show.exitCode === 0) {
      const doc = parseYaml(show.stdout) as Record<string, unknown> | null;
      const v = (doc?.["push"] as Record<string, unknown> | undefined)?.["requireVerifierReview"];
      declared = typeof v === "boolean" ? v : undefined;
    }
  } catch {
    declared = undefined;
  }
  const requireVerifierReview = declared !== false;
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
    if (scannedRanges.includes(range)) continue;
    scannedRanges.push(range);
    for (const hit of await scanVerifierTrailers(repoRoot, io, range)) {
      verifierTrailerCommits.set(hit.sha, hit);
    }
  }
  const trailerHits = [...verifierTrailerCommits.values()].sort((a, b) =>
    a.sha.localeCompare(b.sha),
  );
  if (trailerHits.length > 0 && requireVerifierReview) {
    if (!opts.acceptVerifierTrailers) {
      return {
        digestId: digest.digestId,
        pushed: false,
        refs: [],
        publications: [],
        superseded: [],
        retired: [],
        verifierTrailerCommits: trailerHits,
        diagnostics: [
          {
            ruleId: "FLOW-PUSH-08",
            severity: "error",
            message:
              `${trailerHits.length} unpushed commit(s) carry a verifier/audit trailer ` +
              `(${trailerHits.map((h) => `${h.sha.slice(0, 9)}[${h.trailers.join(",")}]`).join("; ")}) — ` +
              `verifier evidence must be reviewed before it leaves the machine`,
            fixHint:
              "review the commits, then re-run with " +
              '--accept-verifier-trailers "<reason>" — or opt the repository out ' +
              "with push.requireVerifierReview: false in forge.yaml",
          },
        ],
      };
    }
  }

  for (const [branch, remote] of [
    ["develop", digest.develop.remote],
    ["main", digest.main.remote],
  ] as const) {
    if (remote === null) continue;
    const ancestor = await gitEvidence(repoRoot, ["merge-base", "--is-ancestor", remote, branch]);
    if (ancestor.exitCode !== 0) {
      return refuse(
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

  const publicationTags = new Map<string, ReleaseLine>();
  const addCandidate = (tag: string, lineId: string | null): void => {
    const line =
      (lineId === null ? null : lines.find((l) => l.id === lineId)) ?? lineForTag(lines, tag);
    if (line !== null && line.id !== "repo") publicationTags.set(tag, line);
  };
  for (const tag of digest.tags) addCandidate(tag, null);

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
      return refuse(
        "FLOW-PUSH-06",
        `package line ${line.id} has no valid forge.generated.yaml in ${dir} — it must not be published`,
        "re-run flow.install to restore the marker, or remove the line's tags",
      );
    }
  }

  const extractBin = join(primary, "node_modules", ".bin", "repo-extract");
  if (publishable.length > 0 && !(await io.exists(extractBin))) {
    return refuse(
      "FLOW-PUSH-07",
      `${extractBin} is missing while ${publishable.length} tag(s) wait to publish`,
      "install the workspace dependencies so repo-extract is linked",
    );
  }

  // Sha-pinned refspecs — the push ships exactly the reviewed tips; a local
  // branch that moved since the digest stays local instead of sneaking in.
  // Refspecs cover digest.tags in full (R13-C): every tag this run will
  // treat as publishable is pushed in the same atomic push — a fabricated
  // journal `push` record can never make an unpushed tag look remote.
  const pushedTagNames = digest.tags;
  const refspecs = [
    `${digest.develop.local}:refs/heads/develop`,
    `${digest.main.local}:refs/heads/main`,
    ...pushedTagNames.map((t) => `refs/tags/${t}:refs/tags/${t}`),
  ];

  if (opts.dryRun) {
    return {
      digestId: digest.digestId,
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
      diagnostics: [...digest.diagnostics],
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
        fetched: digest.fetched,
        pushed: false,
        refs: refspecs,
        publications: [],
        superseded: [],
        retired: [...retiredTags].sort((a, b) => a.localeCompare(b)),
        verifierTrailerCommits: trailerHits,
        verifierTrailersAccepted: opts.acceptVerifierTrailers,
        diagnostics: [
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
    fetched: digest.fetched,
    pushed,
    refs: refspecs,
    publications,
    superseded: supersededOut,
    retired: [...freshRetired].sort((a, b) => a.localeCompare(b)),
    verifierTrailerCommits: trailerHits,
    verifierTrailersAccepted: opts.acceptVerifierTrailers,
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
