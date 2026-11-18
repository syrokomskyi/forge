/*
<MODULE_CONTRACT>
<purpose>Thin git helpers for os/flow handlers (RFC-1486) — every git
invocation goes through io.exec with an argument vector (DNA-89), exit codes
are checked (DNA-106), and each helper expresses exactly one git fact.</purpose>
<non-goals>
  <item>No branch-model policy — helpers report git facts; handlers decide.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Exit 1 is a legitimate probe-command answer — helpers map it to typed answers; unexpected failures throw.</item>
  <item>flow.check/flow.install require git >= 2.30 — requireGit fails through the standard error path naming the detected version.</item>
  <item>FORGE_STATE_FILES is an exact-path/prefix allowlist; removers delete tolerated paths right before worktree removal.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1515: harden forge flow worktree lifecycle against vanished paths, forge-local state, dead-holder locks and generated drift</item>
  <item>RFC-1515: close rfc-1515 review findings — delete tolerated paths before worktree remove, prune vanished registrations, verified branch -D, shared held-lock render, gated e2e throw, journal toleratedState, edge tests</item>
  <item>RFC-1515: record rfc-1515 review r1 fixes, key decisions and corrected probe path</item>
  <item>ADR-0124: enable git rerere in flow-managed repositories</item>
  <item>RFC-1531: worktreeAdd for --reattach; isForgeStatePath exported for the shared dirty classifier</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r4 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r5 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r6 trust-boundary counterexamples</item>
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
  <item>RFC-1616: close RFC-1616 r8 trust-boundary counterexamples

Independent clean-context verification (round 8, candidate 9da0bf515)
returned REFUTED with nine live counterexamples against the r7-hardened
evidence channel — this commit closes all root causes.

- Committed-object reads carry an integrity anchor: loose objects under
  .git/objects whose inflated bytes do not hash to their object name
  refuse the channel — forged loose bytes and loose-over-packed
  shadowing can no longer serve the anchored base (CX-104a/b).
- policy.digest --verify --base accepts only concrete immutable commit
  identifiers — symbolic/message/index/path revspecs (HEAD^{/...},
  :/..., bare HEAD, branch names) are rejected before verify (CX-103).
- The heredoc lexer is a bash word-grammar scan: <<~EOF arms literal
  ~EOF (CX-105), quote removal applies across the whole word so
  <<'E'OF and <<E"OF" arm EOF (CX-106), and $/command-substitution
  words arm a never-matching sentinel so body lines stay stdin (CX-107).
- verifierGit is a subcommand + option allowlist: reflog/stash and
  write commands (config writes, update-ref) are refused, caller
  -c/-C/--git-dir/--work-tree/--exec-path are rejected instead of
  landing after the pins, and -g inside short-option clusters (-ng) is
  judged (CX-108/109).
- Every remote.<name>.* class keys the name as greedy .+ so dotted
  remotes no longer escape the REFUSE table or fetch value-judge —
  remote.o.r.uploadpack refuses the channel instead of executing inside
  fetch o.r (CX-110); fetch/ls-remote positional remotes are
  form-judged.

The independent r8 probe file and acceptance report land in the
follow-up port commit.</item>
  <item>RFC-1616: close RFC-1616 r9 trust-boundary counterexamples

Independent clean-context verification (round 9, candidate 4436339db)
returned REFUTED with ten live counterexamples against the r8-hardened

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
  <item>RFC-1616: close RFC-1616 r10 trust-boundary counterexamples

Independent clean-context verification (round 10, candidate 17c0ec075)
returned REFUTED with two live counterexamples against the
r9-remediated channel — this commit closes both root causes.

- The core.hooksPath pin target is the null device, not a plantable
  temp dir (CX-123): the mkdtemp evidenceHooksDir persisted for the
  process lifetime under the session-owned OS temp root, so a
  concurrent same-uid session could poll, discover it, and plant an
  executable reference-transaction hook that the next pinned fetch
  executed inside the trusted spawn. The pin now aims at DEVNULL —
  the ENOTDIR hook stat skips every hook silently and a char device
  has no plantable entries; no verifier hooks dir exists at all,
  removing the TMPDIR amplifier too.
- A failed claims rebuild is fail-closed, scoped to the reads it can
  poison (CX-124): prepareEvidenceIndex returned {} on a failed
  update-index --index-info, routing index-consulting reads at the
  ambient session-writable .git/index — a CX-121 stat-forged index
  then answered clean on dirty bytes on both channels. The failure
  now marks the index unproven in the preflight, and
  isUnprovenIndexRead refuses exactly the index-consulting ops
  (status/ls-files always; diff unless tree-to-tree; grep unless
  tree-anchored; ambiguous shapes refuse) on all three channels.
  Non-index reads proceed, so a corrupt-index fixture degrades
  per-read (the gate's git-read-failed contract) instead of dying
  channel-wide.

The independent r10 probe file and acceptance report land in the
follow-up port commit.</item>
  <item>RFC-1616: close RFC-1616 r11 trust-boundary counterexamples

Independent clean-context verification (round 11, candidate 029219ca9)
returned REFUTED with seven live counterexamples against the
r10-remediated channel — this commit closes all of them.

- `.git/info/attributes` joins the shape-violation paths (CX-125): the
  r6 reasoning covered only program reach, but working-tree-encoding /
  text / eol / ident are built-in clean-side conversions that rewrite
  what the zero-stat index content-hash sees with no external program.
- Index-consulting classification is argv-exact (CX-126/127/128):
  isIndexConsultingRead replaces the token-counting isUnprovenIndexRead —
  ambiguous diff forms (a nonrev second positional is a pathspec, not a
  rev) refuse under an unproven index, describe --dirty/--broken are
  index-consuming, and grep is parsed option-aware so a worktree grep
  with no rev token refuses while `-e`/`-f` + rev tree greps proceed.
- The verifier claims index has no discoverable path (CX-129): a
  self-serialized DIRC v2 image lives in an anonymous O_TMPFILE inode
  opened on os.tmpdir(), handed to git as GIT_INDEX_FILE=/dev/fd/<n>
  through a freshly opened independent file description per spawn;
  the named flat-file fallback re-proves its bytes against the expected
  image before every spawn, and child descriptors close on every return
  path.
- `cat-file --batch` specs are sanitized (CX-130): runBatchBytes rejects
  empty specs and any spec containing \n/\r/\0 (and `:`-leading index
  specs under an unproven index), answering positional nulls so the
  record stream can never desynchronize spec attribution.
- Trusted transports refuse file-class targets and URL rewrites
  (CX-131): url.*.insteadOf / .pushInsteadOf are refused at preflight,
  and ls-remote/fetch spawn with protocol.file.allow=never so file:
  URLs and bare-path remotes fail honestly; the pin is transport-only
  so verifierScratchGit's judged `clone <path>` still works. Test
  origins moved from local path/file remotes to a loopback git daemon
  so fixtures keep exercising real fetch/ls-remote behavior.

The port commit that follows carries the ported cx11 probe file plus
the round-11 acceptance report.</item>
  <item>RFC-1616: close RFC-1616 r12 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r13 trust-boundary counterexamples</item>
  <item>RFC-1616: close RFC-1616 r14 trust-boundary counterexamples</item>
  <history>ADR-0124, RFC-1486, RFC-1487, RFC-1490, RFC-1491, RFC-1515, RFC-1531, RFC-1616</history>
</CHANGE_SUMMARY>
*/

import type { ExecResult, WorkspaceIO } from "../../src/types.ts";
import { canonicalRepoDir } from "../../src/utils/repo-path.ts";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  resolveGitBin,
  verifierGitEnv,
  filterEvidenceExtraEnv,
  evidencePinEnv,
  evidenceSpawnState,
  evidenceSpawnArgs,
  closeEvidenceIndex,
  closeSpawnFds,
  judgeEvidenceRepoSurface,
  scanPackObjects,
  prepareEvidenceIndex,
  spawnCaptured,
  captureEvidenceSurface,
  reproveEvidenceSurface,
  resolutionEnv,
  sessionIgnoreRulePaths,
  type EvidenceFingerprint,
  type EvidencePreflight,
  EVIDENCE_REFUSED_PREFIX,
  isEvidenceGitQuery,
  isIndexConsultingRead,
} from "../../src/utils/verifier-git.ts";

/**
 * The argv judgment the evidence channel applies — owned by
 * `src/utils/verifier-git.ts` since r8 so the runner/policy channel
 * (`verifierGit`) and the scratch channel (`verifierScratchGit`) judge
 * against the same table (CX-108/109); re-exported here so existing
 * flow-side callers keep their import site.
 */
export { isEvidenceGitQuery };

export const MIN_GIT_VERSION = "2.33";

export interface FlowWorktree {
  path: string;
  head: string;
  /** Short branch name when the worktree carries one; null when detached or bare. */
  branch: string | null;
  bare: boolean;
}

export async function git(
  repoRoot: string,
  io: WorkspaceIO,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<ExecResult> {
  // Writes and session-config ops (commit identity, credential helpers,
  // url.insteadOf, hooks) need the session environment — the scrubbed
  // evidence channel drops global config, which would break authenticated
  // push and configured commit identity for every consumer.
  return io.exec("git", ["-C", repoRoot, ...args], { env: opts?.env });
}

/**
 * RFC-1616: git on the trust boundary — same `-C <root>` call shape as
 * `git()`, but spawned on the resolved real binary with a scrubbed env:
 * session `GIT_*` variables are stripped wholesale (repo redirection,
 * config/URL rewrites, transport and exec-path overrides), `refs/replace`
 * substitution is off, global/system config reads `/dev/null`, and the
 * executable cannot be a session PATH shim — committed evidence the
 * verifier judges must be the object's real bytes (CX-46..CX-52). The
 * execFile call stays inside this argv-shaped body so the read-only scan's
 * git-allowlist model judges every callsite's argv the same way it judges
 * `git()` routes; `io.exec` merges env over `process.env` and could never
 * delete a hostile variable, which is why evidence reads do not go through
 * the io adapter. The ExecResult shape stays identical.
 */
export async function gitEvidence(
  repoRoot: string,
  args: string[],
  opts?: {
    timeoutMs?: number;
    extraEnv?: Record<string, string>;
    internalEnv?: Record<string, string>;
    preflight?: boolean;
  },
): Promise<ExecResult> {
  // Runtime argv judgment — the evidence channel spawns a trusted git, so
  // nothing beyond the read-only + pinned-fetch table may reach it, even
  // through a dynamic tail the static scan cannot see (CX-70).
  if (!isEvidenceGitQuery(args)) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `gitEvidence refused argv outside the evidence allowlist: git ${args.join(" ")}`,
    };
  }
  // The session-writable repo surface is judged before every spawn —
  // transport/exec config keys `-c` cannot reach and .git metadata files
  // that rewrite what a read resolves make any answer fabricable, so the
  // channel refuses rather than trusting it (CX-72..CX-79). A repo that
  // cannot even be enumerated is unverifiable — fail closed. The
  // preflight enumerates through this same channel (preflight:false
  // breaks the recursion), so every subprocess on the evidence path stays
  // inside this argv-judged body.
  let preflight = opts?.preflight === false ? null : await evidencePreflight(repoRoot);
  // Re-prove the fingerprint right before the spawn, and keep re-
  // preflighting while the surface drifts — the LAST check is always
  // immediate before the spawn (R13-D1: a one-shot reprove+reflight
  // left a whole second-preflight window for a config flipper).
  for (
    let attempt = 0;
    preflight !== null && !reproveEvidenceSurface(repoRoot, preflight);
    attempt++
  ) {
    // The prior fingerprint's resolution anchors pin the re-preflight's
    // resolves — a commondir/gitfile plant between captures cannot
    // steer re-resolution into a forged common dir (CX-143).
    const priorFp = preflight.fingerprint;
    closeEvidenceIndex(preflight);
    preflight = attempt >= 2 ? null : await evidencePreflight(repoRoot, priorFp);
  }
  try {
    if (preflight === null && opts?.preflight !== false) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: repo config could not be enumerated — evidence would be unverifiable`,
      };
    }
    if (
      preflight !== null &&
      (preflight.refusedKeys.length > 0 || preflight.shapeViolations.length > 0)
    ) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: ${[...preflight.refusedKeys, ...preflight.shapeViolations].join(", ")}`,
      };
    }
    // A config that exists but could not be captured refuses EVERYTHING
    // — its bytes are live-unjudgeable for drift and the spawn would
    // read them (R13-D). The levers themselves are dead either way:
    // env pins cover the literal keyspace and `GIT_ATTR_SOURCE` starves
    // the pattern class, so this guard is about provability, not
    // exposure.
    if (preflight?.configUnproven !== undefined) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: ${preflight.configUnproven}: git ${args.join(" ")}`,
      };
    }
    // The verifier index is resolved per spawn — fd form carries no
    // path at all (CX-129); the path form re-proves its on-disk bytes
    // before the redirect is trusted. An unproven index (rebuild
    // failed, CX-124, or a rewrite caught just now) refuses
    // index-consulting ops; non-index ops never consult it and proceed.
    const spawnState = evidenceSpawnState(preflight);
    if (spawnState.unproven && isIndexConsultingRead(args)) {
      closeSpawnFds(spawnState);
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: index unproven (${preflight?.indexUnproven ?? "index bytes rewritten"}): git ${args.join(" ")}`,
      };
    }
    const r = await spawnCaptured(resolveGitBin(), ["-C", repoRoot, ...evidenceSpawnArgs(args)], {
      cwd: repoRoot,
      env: {
        ...verifierGitEnv(),
        // Pins ride the env (GIT_CONFIG_*), not argv — the spawned
        // argv is the judged query verbatim (CX-115 r9 regression:
        // argv pins shifted $1/$2 positional matching in
        // failure-injection seams).
        ...evidencePinEnv(args, preflight),
        // The verifier-owned claims index + `GIT_ATTR_SOURCE` — the
        // session's `.git/index` is never consulted, and no attribute
        // ever engages a config-named program (CX-121/CX-129, R13-D).
        ...spawnState.env,
        ...filterEvidenceExtraEnv(opts?.extraEnv),
        // Resolution pins land last — verifier-owned internals
        // (preflight subprocesses) are never caller-overridable
        // (CX-143).
        ...(opts?.internalEnv ?? {}),
      },
      // Boundary reads are local and bounded like the runner channel —
      // the transport ops that needed a generous window are refused
      // outright (CX-132), so no trusted read may stall ten minutes on
      // a hanging child (r12 hunt note).
      timeoutMs: opts?.timeoutMs ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
      indexFd: spawnState.indexFd,
    });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } finally {
    // The per-call preflight owns its held fds — cached preflights
    // (OriginGit) keep them for the instance's lifetime instead.
    closeEvidenceIndex(preflight);
  }
}

/**
 * Enumerate the session-writable repo surface for the evidence channel —
 * the two capture reads ride `gitEvidence` itself (`preflight:false`
 * skips the recursion) so their subprocesses stay inside the argv-judged
 * body and their argv stays allowlist-literal. Each `--git-path` query is
 * its own call — a resolved path may itself CONTAIN a newline
 * (linked-worktree common dir under a hostile dirname, CX-89), so a
 * multi-query line split cannot keep the judge's positional map honest.
 * `null` when the surface cannot be enumerated — the caller fails closed.
 * A dead resolved binary throws instead: the channel itself is broken and
 * no verdict may be derived (R4-R2's fail-loud contract) — distinguished
 * from an unenumerable repo by whether a bare `--version` spawns.
 */
export async function evidencePreflight(
  repoRoot: string,
  prior?: EvidenceFingerprint | null,
): Promise<EvidencePreflight | null> {
  // Indirection files first (CX-134/135): the `.git` gitfile/commondir
  // state the `--git-path` resolves depend on must be captured BEFORE
  // them, so a redirect rewrite is always later-than-fingerprint.
  // Indirection → resolves → fingerprint, fused so the ordering contract
  // (CX-134/135) cannot be misordered; `config` and `index` join the
  // shape resolves so the fingerprint pins the files the judged
  // dump/claims derive from. `prior` is the previous capture on a drift
  // re-preflight — its resolution anchors pin this capture's resolves
  // so a mid-flight commondir/gitfile plant cannot steer them (CX-143).
  const { objectsDir, shapePaths, headBranch, anyFailed, fingerprint } =
    await captureEvidenceSurface(repoRoot, gitEvidence, prior);
  if (anyFailed) {
    if (!existsSync(repoRoot)) return null;
    const probe = await gitEvidence(repoRoot, ["--version"], { preflight: false });
    if (probe.exitCode !== 0) {
      throw new Error(
        `resolved git is unreachable — evidence reads cannot be judged (${probe.stderr.trim() || `exit ${probe.exitCode}`})`,
      );
    }
    return null;
  }
  // Resolution pins for every internal subprocess — the judged surface
  // and the spawns it enumerates stay anchored to the captured gitdir
  // (CX-143).
  const internalEnv = resolutionEnv(fingerprint);
  // `--git-path objects` resolves the real object store — shared for
  // linked worktrees — so the loose-object re-hash judges the same files
  // the reads below would serve (CX-104). A failed resolve feeds the
  // judge `null`, which it counts as a violation — an unproven object
  // store must refuse, not silently skip the check. A `.git/config`
  // that exists but could not be byte-captured cannot be drift-checked
  // (R13-D) — a NON-REGULAR one (FIFO, CX-144) additionally hangs git's
  // own dump read, so the dump is skipped and the unproven flag refuses
  // every spawn on its own.
  const configUnproven =
    fingerprint.configPath !== null &&
    fingerprint.configBytes === null &&
    existsSync(fingerprint.configPath)
      ? ".git/config exists but could not be captured — spawn would read unjudged config"
      : undefined;
  const listed =
    configUnproven === undefined
      ? await gitEvidence(repoRoot, ["config", "--local", "--no-includes", "--list", "--null"], {
          preflight: false,
          internalEnv,
        })
      : { exitCode: 0, stdout: "", stderr: "" };
  if (listed.exitCode !== 0) return null;
  const preflight = judgeEvidenceRepoSurface(
    repoRoot,
    listed.stdout,
    shapePaths,
    objectsDir,
    headBranch,
    fingerprint,
  );
  // Pack-carried objects get the same integrity anchor loose objects
  // have (CX-113) — skipped when the objects dir could not be resolved,
  // which is already a shapeViolation.
  if (objectsDir !== null && objectsDir !== undefined) {
    const absObjects = isAbsolute(objectsDir) ? objectsDir : resolve(repoRoot, objectsDir);
    preflight.shapeViolations.push(...(await scanPackObjects(absObjects, internalEnv)));
  }
  // `.git/index` is session-writable — a forged stat tuple answers
  // status/diff clean on dirty bytes (CX-121). Every index-consulting
  // spawn below resolves this verifier-owned zero-stat claims index as
  // an inherited fd — no same-uid-rewritable path ever holds it
  // (CX-129). A failed rebuild marks the index unproven (CX-124):
  // index-consulting reads refuse, non-index reads stay trustworthy. A
  // non-regular index (CX-144) skips the spawn — its claims enumeration
  // would only block git's own open of the FIFO.
  const indexNonRegular =
    fingerprint.indexPath !== null &&
    fingerprint.indexBytes === null &&
    (() => {
      try {
        return !statSync(fingerprint.indexPath!).isFile();
      } catch {
        return false;
      }
    })();
  const prepared = indexNonRegular
    ? { failure: ".git/index is a non-regular file — claims enumeration would block" }
    : await prepareEvidenceIndex(repoRoot, internalEnv);
  preflight.index = prepared.index;
  preflight.indexUnproven = prepared.failure;
  preflight.configUnproven = configUnproven;
  preflight.fingerprint = fingerprint;
  return preflight;
}

/** `topLevel` over the scrubbed boundary channel — same canonicalization. */
export async function verifierTopLevel(cwd: string): Promise<string | null> {
  const result = await gitEvidence(cwd, ["rev-parse", "--show-toplevel"]);
  return result.exitCode === 0 ? canonicalRepoDir(result.stdout.trim()) : null;
}

/**
 * Normalize one `%(trailers:only)` output into `{key, value}` entries —
 * git's own parser decides what is a trailer, so `x-verifier-report:` and
 * `X-Verifier-Report :` spellings both appear here (case-insensitive key,
 * whitespace folded); a hand-rolled body regex cannot match this
 * normalization and misses Git-recognized trailer forms (CX-60).
 */
export function parseGitTrailers(stdout: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of stdout.split("\n")) {
    const m = /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(line);
    if (m) out.push({ key: m[1]!.trim().toLowerCase(), value: m[2]!.trim() });
  }
  return out;
}

/**
 * `git` with `FORGE_FLOW_COMMIT=<op>` in the child env — the informational
 * marker every flow-owned commit/merge/cherry-pick carries (RFC-1490). The
 * guard does not read this variable; `extraEnv` merges caller env (e.g.
 * `FORGE_FLOW_OP` where the guard vocabulary still applies).
 */
export async function gitCommit(
  worktree: string,
  io: WorkspaceIO,
  args: string[],
  op: string,
  extraEnv?: Record<string, string>,
): Promise<ExecResult> {
  return git(worktree, io, args, { env: { ...extraEnv, FORGE_FLOW_COMMIT: op } });
}

function throwOnFailure(result: ExecResult, what: string): ExecResult {
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

/** Require git >= 2.30 — the resolved real binary answers, not whatever a
 * session PATH shim reports for `git` (CX-52). `preflight:false`: a
 * `--version` probe consults no repo state, so a refused repo surface
 * (e.g. `.git/info/exclude` content, CX-141) must not fail the binary
 * health check — the reads that follow carry their own judgment. */
export async function requireGit(io: WorkspaceIO): Promise<void> {
  void io;
  const result = await gitEvidence(process.cwd(), ["--version"], { preflight: false });
  if (result.exitCode !== 0) {
    throw new Error("git is required for flow commands but `git --version` failed");
  }
  const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
  if (!match) {
    throw new Error(`could not parse git version from "${result.stdout.trim()}"`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 30)) {
    throw new Error(`flow commands require git >= ${MIN_GIT_VERSION} (found ${match[0]})`);
  }
}

/** Absolute path of the repository top level; null when cwd is not a repo. */
export async function topLevel(cwd: string, _io: WorkspaceIO): Promise<string | null> {
  const result = await gitEvidence(cwd, ["rev-parse", "--show-toplevel"]);
  // Canonicalize to the native real path — git reports forward slashes and
  // the on-disk long name, while callers hold whatever spelling the user
  // passed (possibly an 8.3 alias on Windows); the canonical form is what
  // downstream equality comparisons are written against.
  return result.exitCode === 0 ? canonicalRepoDir(result.stdout.trim()) : null;
}

export async function isBare(repoRoot: string, _io: WorkspaceIO): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--is-bare-repository"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** Current branch short name; null on detached HEAD (symbolic-ref fails). */
export async function currentBranch(repoRoot: string, _io: WorkspaceIO): Promise<string | null> {
  const result = await gitEvidence(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** True when HEAD has no commit yet (unborn branch). */
export async function isUnborn(repoRoot: string, _io: WorkspaceIO): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]);
  return result.exitCode !== 0;
}

export async function listLocalBranches(repoRoot: string, _io: WorkspaceIO): Promise<string[]> {
  const result = throwOnFailure(
    await gitEvidence(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    "git for-each-ref",
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Remote-tracking refs under `refs/remotes` as `<remote>/<branch>` shorts. */
export async function listRemoteBranches(repoRoot: string, _io: WorkspaceIO): Promise<string[]> {
  const result = throwOnFailure(
    await gitEvidence(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
    "git for-each-ref refs/remotes",
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** True when `ancestor` is an ancestor of `descendant` (merge-base --is-ancestor). */
export async function isAncestor(
  repoRoot: string,
  _io: WorkspaceIO,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}

/** ISO committer timestamp of `ref`'s tip; null when the ref is missing. */
export async function lastCommitAt(
  repoRoot: string,
  io: WorkspaceIO,
  ref: string,
): Promise<string | null> {
  const result = await gitEvidence(repoRoot, ["log", "-1", "--format=%cI", ref]);
  return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

export async function branchExists(
  repoRoot: string,
  io: WorkspaceIO,
  name: string,
): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
  return result.exitCode === 0;
}

/** Commit count in a rev range, e.g. "develop..main". */
export async function revListCount(
  repoRoot: string,
  io: WorkspaceIO,
  range: string,
): Promise<number> {
  const result = throwOnFailure(
    await gitEvidence(repoRoot, ["rev-list", "--count", range]),
    `git rev-list --count ${range}`,
  );
  return Number(result.stdout.trim());
}

/**
 * True when `ref` carries a commit whose subject matches `grep` — git's
 * default basic-regex --grep treats parentheses literally, so the adoption
 * subject `chore(flow): …` matches without escaping.
 */
export async function revListHasSubject(
  repoRoot: string,
  io: WorkspaceIO,
  ref: string,
  grep: string,
): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-list", "-1", `--grep=${grep}`, ref]);
  if (result.exitCode !== 0) return false;
  return result.stdout.trim().length > 0;
}

/**
 * True when `path` exists in the tree of `ref` (e.g. `develop`,
 * `HEAD`). Uses `cat-file -e` — any non-zero exit means absent, including an
 * unborn `ref` (exit 128).
 */
export async function fileInTree(
  repoRoot: string,
  io: WorkspaceIO,
  ref: string,
  path: string,
): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["cat-file", "-e", `${ref}:${path}`]);
  return result.exitCode === 0;
}

/**
 * Decode one porcelain value — git C-quotes paths containing spaces or
 * specials (`"a b"` → `"a\040b"` is octal-escaped inside the quotes).
 */
function unquotePorcelain(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  return inner
    .replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(.)/g, (_m, ch: string) => {
      switch (ch) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case '"':
          return '"';
        case "\\":
          return "\\";
        default:
          return ch;
      }
    });
}

/** Parse `git worktree list --porcelain`; first entry is always the primary. */
export async function worktreeList(repoRoot: string, _io: WorkspaceIO): Promise<FlowWorktree[]> {
  // Worktree topology feeds primary-checkout resolution on the boundary —
  // scrubbed channel so a session GIT_* cannot redirect it (CX-51 class).
  const result = throwOnFailure(
    await gitEvidence(repoRoot, ["worktree", "list", "--porcelain"]),
    "git worktree list",
  );
  const worktrees: FlowWorktree[] = [];
  // Entries are blank-line separated; quoted paths escape real newlines,
  // so a split on "\n\n" is safe against embedded whitespace.
  for (const block of result.stdout.split("\n\n")) {
    if (block === "") continue;
    let pathField: string | undefined;
    let head = "";
    let branch: string | null = null;
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        pathField = unquotePorcelain(line.slice("worktree ".length));
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = unquotePorcelain(line.slice("branch refs/heads/".length));
      } else if (line === "bare") {
        bare = true;
      }
    }
    if (pathField !== undefined) {
      worktrees.push({
        // Same canonicalization as topLevel — porcelain paths arrive in
        // git's resolved frame, consumers compare them to Node-side paths.
        path: canonicalRepoDir(pathField),
        head,
        branch,
        bare,
      });
    }
  }
  return worktrees;
}

/**
 * RFC-1531: `git worktree add <path> <branch>` for an EXISTING branch — the
 * reattach leg of a vanished registered worktree. Thin wrapper: the caller
 * reads the exit code (FLOW-INT-17 on failure); it never throws.
 */
export async function worktreeAdd(
  repoRoot: string,
  io: WorkspaceIO,
  path: string,
  branch: string,
): Promise<ExecResult> {
  return git(repoRoot, io, ["worktree", "add", path, branch]);
}

/** `git config --get` — null when the key is unset (exit 1). */
export async function configGet(
  repoRoot: string,
  io: WorkspaceIO,
  key: string,
): Promise<string | null> {
  const result = await gitEvidence(repoRoot, ["config", "--get", key]);
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1) return null;
  throw new Error(
    `git config --get ${key} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}

/**
 * ADR-0124: flow-managed repositories keep `rerere.enabled` and
 * `rerere.autoupdate` set — an identical rebase conflict shape replays the
 * recorded resolution instead of demanding a fresh manual resolve on every
 * `develop` advance. Shared repository config: always write against the
 * repo root, never --worktree (rr-cache lives in the common git dir).
 * Returns human-readable failure strings; a write failure degrades to a
 * diagnostic, never a refusal.
 */
export async function ensureRerere(repoRoot: string, io: WorkspaceIO): Promise<string[]> {
  const failures: string[] = [];
  for (const [key, value] of [
    ["rerere.enabled", "true"],
    ["rerere.autoupdate", "true"],
  ] as const) {
    const r = await git(repoRoot, io, ["config", key, value]);
    if (r.exitCode !== 0) {
      failures.push(`git config ${key} ${value} failed: ${r.stderr.trim()}`);
    }
  }
  return failures;
}

/**
 * RFC-1515: forge-local state that never counts as worktree dirt — exact
 * paths or explicit directory prefixes only (a trailing slash marks the
 * prefix form). A broad `.forge/` glob would mask real dirt: authored state
 * like `.forge/pinned.yaml` is tracked and stays a blocker (AC-7).
 */
export const FORGE_STATE_FILES: readonly string[] = [
  ".forge/knowledge-conflicts.txt",
  ".forge/task/",
];

/** Typed status verdict (RFC-1513's helpers return this under RFC-1515). */
export interface DirtyStatus {
  /** Porcelain lines that still count as uncommitted changes. */
  entries: string[];
  /** FORGE_STATE_FILES-matched untracked paths — journal data, never a blocker. */
  toleratedState: string[];
  /** True when the worktree path does not exist on disk — no git call ran. */
  vanished: boolean;
}

/** Exported for the RFC-1531 dirty classifier — same path allowlist check. */
export function isForgeStatePath(path: string): boolean {
  return FORGE_STATE_FILES.some((entry) =>
    entry.endsWith("/") ? path === entry || path.startsWith(entry) : path === entry,
  );
}

function porcelainLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/**
 * Tracked modifications in a worktree — `git status --porcelain
 * --untracked-files=no`; untracked and ignored files never count (missions/,
 * releases/, node_modules/ are operational state, not tracked content).
 * RFC-1515: a vanished worktree reports `vanished: true` instead of a raw
 * git exit-128 — callers classify the lifecycle state, not a crash.
 */
export async function statusTracked(worktree: string, io: WorkspaceIO): Promise<DirtyStatus> {
  if (!(await io.exists(worktree))) {
    return { entries: [], toleratedState: [], vanished: true };
  }
  const result = throwOnFailure(
    await gitEvidence(worktree, ["status", "--porcelain", "--untracked-files=no"]),
    "git status --porcelain",
  );
  // `!!` entries never count: ignored files are not tracked
  // modifications (the injected `--ignored` makes them visible under
  // `-uall`; defensively filtered here too, CX-142).
  return {
    entries: porcelainLines(result.stdout).filter((l) => !l.startsWith("!! ")),
    toleratedState: [],
    vanished: false,
  };
}

/**
 * All uncommitted changes — `git status --porcelain -uall` (untracked `??`
 * entries included; `--ignored` additionally exposes `!!` entries, which
 * committed-rule ignores exclude from the verdict — but a `.gitignore` a
 * commit never owned is session-authored dirt itself: an untracked rule
 * can hide itself and every path it covers from status outright, so the
 * verdict is forged without it, CX-142). This is the dirty definition
 * `git worktree remove` enforces; use it wherever a check predicts
 * worktree-removability or asks "is this checkout dirty". `-uall` expands
 * untracked directories into their member files — the FORGE_STATE_FILES
 * partition must see `.forge/task/x`, never the collapsed `?? .forge/` line
 * (RFC-1515). Matched paths partition into `toleratedState` (journal data,
 * never a blocker); a vanished worktree reports `vanished: true` instead of
 * propagating exit-128.
 */
export async function statusDirty(worktree: string, io: WorkspaceIO): Promise<DirtyStatus> {
  if (!(await io.exists(worktree))) {
    return { entries: [], toleratedState: [], vanished: true };
  }
  const result = throwOnFailure(
    await gitEvidence(worktree, ["status", "--porcelain", "-uall"]),
    "git status --porcelain",
  );
  const entries: string[] = [];
  const toleratedState: string[] = [];
  for (const line of porcelainLines(result.stdout)) {
    const path = line.slice(3);
    // `!!` entries are hidden-by-rule files — committed `.gitignore`
    // policy excludes them from the verdict, while the session-authored
    // rules below can never silence their own presence (CX-142). A
    // forge-state path under such a rule is still disposable state:
    // RFC-1515 deletes toleratedState before `git worktree remove`, and
    // removing the covering `.gitignore` first would unhide the rest and
    // wedge the removal (FLOW-INT-04).
    if (line.startsWith("!! ")) {
      if (isForgeStatePath(path)) toleratedState.push(path);
      continue;
    }
    // Porcelain C-quotes unusual bytes ("dir/na\303\257ve.ts") — a quoted
    // path never matches the allowlist and stays a blocker (fail-closed).
    if (line.startsWith("?? ") && isForgeStatePath(path)) toleratedState.push(path);
    else entries.push(line);
  }
  // Session-authored ignore rules: an untracked `.gitignore` can hide
  // itself from status entirely, so the fs walk + tracked-set check is
  // the only honest enumeration (CX-142). A failed tracked read counts
  // every rule as session-authored — fail closed.
  const sessionRules = await sessionIgnoreRulePaths(worktree, async (paths) => {
    const r = await gitEvidence(worktree, ["ls-files", "-z", "--", ...paths]);
    return r.exitCode === 0 ? new Set(r.stdout.split("\0").filter((p) => p.length > 0)) : null;
  });
  for (const p of sessionRules) {
    if (entries.some((e) => e.slice(3) === p) || toleratedState.includes(p)) continue;
    // A session-authored rule under `.forge/` can only hide paths the
    // verdict already tolerates (`.gitignore` scope is its own subtree)
    // — it joins toleratedState like every other forge journal path;
    // a root or product-tree rule still counts as blocking dirt.
    if (isForgeStatePath(p)) toleratedState.push(p);
    else entries.push(`?? ${p}`);
  }
  return { entries, toleratedState, vanished: false };
}
