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
  <item>RFC-1616: close r38 trust-boundary counterexamples — worktree consult surface, root fd-binding</item>
  <item>RFC-1616: totalize the worktree arm — anchored reads, compare-under-arm, check-ignore, embedded-gitdir refusal</item>
  <item>RFC-1616: admit-list ls-files worktree scope and pin internal check-ignore consults (RFC-1616 r40)</item>
  <item>RFC-1616: close r41 trust-boundary counterexamples — per-argv ignored-dir prune, file-valued argv strip/forbid, unconditional upstream pins</item>
  <item>RFC-1633: serialize evidence consults + bestEffort reader mode (RFC-1633)</item>
  <history>ADR-0124, RFC-1486, RFC-1487, RFC-1490, RFC-1491, RFC-1515, RFC-1531, RFC-1616</history>
</CHANGE_SUMMARY>
*/

import type { ExecResult, WorkspaceIO } from "../../src/types.ts";
import { canonicalRepoDir } from "../../src/utils/repo-path.ts";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  resolveGitBin,
  verifierGitEnv,
  filterEvidenceExtraEnv,
  evidencePinEnv,
  execEvidenceGit,
  evidenceSpawnState,
  evidenceSpawnArgs,
  closeEvidenceIndex,
  closeSpawnFds,
  judgeEvidenceRepoSurface,
  scanPackObjects,
  prepareEvidenceIndex,
  spawnCaptured,
  captureEvidenceSurface,
  captureWorktreeSurface,
  markIgnoredDirs,
  ignoredDirSetFromCheckIgnore,
  reproveEvidenceSurface,
  armEvidenceWindowWatch,
  geometryLocalAnswer,
  substituteOverlayPaths,
  catFileObjectRequest,
  resolutionEnv,
  sessionIgnoreRulePaths,
  unprovenIgnoredPaths,
  resolveWorktreeArm,
  type EvidenceFingerprint,
  type EvidencePreflight,
  EVIDENCE_REFUSED_PREFIX,
  isEvidenceGitQuery,
  isIndexConsultingRead,
  reportsRepoGeometry,
  repoShaped,
} from "../../src/utils/verifier-git.ts";
import { LockTimeoutError } from "./locks.ts";
import {
  describeEvidenceLockError,
  evidenceConsultBudgetMs,
  withEvidenceConsultLock,
} from "./evidence-lock.ts";

/** RFC-1633: consult modes — `judged` is the default judged consult
 * (preflight+watch+settle, trusted:true); `bestEffort` skips all judgment
 * machinery for non-verdict readers and marks the result untrusted. */
export type EvidenceMode = "judged" | "bestEffort";

export interface EvidenceResult extends ExecResult {
  /** RFC-1633: false only for mode "bestEffort" results — advisory data
   * no verdict may consume (`assertJudgedEvidence` polices the boundary). */
  trusted: boolean;
}

/** RFC-1633: verdict-consuming boundaries assert judged provenance — a
 * `trusted:false` result here is a wiring error, not an environmental
 * refusal, so it throws EVIDENCE-MODE rather than returning data. */
export function assertJudgedEvidence(
  result: EvidenceResult,
): asserts result is EvidenceResult & { trusted: true } {
  if (result.trusted !== true) {
    throw new Error(
      "EVIDENCE-MODE: untrusted (bestEffort) evidence reached a verdict-consuming boundary",
    );
  }
}

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
    /** Extra file inodes folded into the spawn-window watch (see `verifierGit`). */
    extraWatchPaths?: readonly string[];
    /** RFC-1633: opt-in degraded mode for non-verdict readers — skips
     * preflight/watch/settle and the consult lock, returns `trusted: false`.
     * The argv allowlist still applies. */
    mode?: EvidenceMode;
    /** RFC-1633: cumulative bound on preflight+arm+settle, measured from
     * consult-lock acquisition (judged only). */
    consultBudgetMs?: number;
    /** RFC-1633: bound on the evidence-consult lock wait (judged only). */
    lockWaitMs?: number;
  },
): Promise<EvidenceResult> {
  // Runtime argv judgment — the evidence channel spawns a trusted git, so
  // nothing beyond the read-only + pinned-fetch table may reach it, even
  // through a dynamic tail the static scan cannot see (CX-70). bestEffort
  // consults judge argv on the same table — the allowlist is the channel's
  // argv boundary, independent of provenance mode (RFC-1633).
  if (!isEvidenceGitQuery(args)) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `gitEvidence refused argv outside the evidence allowlist: git ${args.join(" ")}`,
      trusted: opts?.mode !== "bestEffort",
    };
  }
  // RFC-1633 bestEffort: the same scrubbed spawn on the resolved real
  // binary — none of the judgment machinery (no preflight, no watch, no
  // settle, no lock). The result is advisory data, never evidence.
  if (opts?.mode === "bestEffort") {
    const r = await spawnCaptured(resolveGitBin(), ["-C", repoRoot, ...args], {
      cwd: repoRoot,
      env: {
        ...verifierGitEnv(),
        ...filterEvidenceExtraEnv(opts?.extraEnv),
        ...(opts?.internalEnv ?? {}),
      },
      timeoutMs: opts?.timeoutMs ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
      trusted: false,
    };
  }
  // A mid-window refusal means the surface MOVED during the judged read —
  // the child's answer is untrustworthy, but the repo itself may settle a
  // millisecond later. Re-attempting re-preflights a stable surface and
  // re-reads honestly; a persistent foreign writer still refuses once the
  // flux budget is spent (RFC-1616 R25 follow-up — callers no longer need
  // per-site catch loops for transient churn).
  const fluxDeadline = Date.now() + 2_000;
  // RFC-1633: judged consults serialize per commonGitDir — the lock wraps
  // ONE attempt so a flux retry re-acquires and a retrying holder never
  // starves waiters. `preflight:false` internal enumeration reads skip
  // the lock (they already run inside the holder's serialized window).
  // consultStartedAt is stamped on first acquisition — the consult budget
  // is cumulative across retries, and the lock wait itself is separately
  // bounded by lockWaitMs.
  let consultStartedAt: number | undefined;
  for (;;) {
    let r: ExecResult;
    try {
      r =
        opts?.preflight === false
          ? await gitEvidenceAttempt(repoRoot, args, opts)
          : await withEvidenceConsultLock(
              repoRoot,
              { waitMs: opts?.lockWaitMs, command: `git ${args.join(" ")}` },
              async () => {
                consultStartedAt ??= Date.now();
                return gitEvidenceAttempt(repoRoot, args, {
                  ...opts,
                  consultStartedAt,
                });
              },
            );
    } catch (error) {
      // EVIDENCE-LOCKED is a distinct refusal class — it names the lock
      // holder and does NOT re-enter the flux ride-out (which keys on
      // mid-window "during the judged read" refusals).
      if (error instanceof LockTimeoutError) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: await describeEvidenceLockError(repoRoot, error),
          trusted: true,
        };
      }
      throw error;
    }
    if (
      r.exitCode !== -1 ||
      r.exitCode === null ||
      !r.stderr.includes("during the judged read") ||
      Date.now() >= fluxDeadline
    ) {
      return { ...r, trusted: true };
    }
    await new Promise((r2) => setTimeout(r2, 120));
  }
}

/**
 * RFC-1633: cumulative wall-clock bound on preflight+arm+settle — the clock
 * starts at consult-lock acquisition (`consultStartedAt`), not per phase.
 * Returns the EVIDENCE-BUDGET refusal naming the active phase, or null.
 * Exported for the RFC-1633 serialization tests.
 */
export function evidenceBudgetBreach(
  args: string[],
  phase: "preflight" | "arm" | "settle",
  consultStartedAt: number | undefined,
  consultBudgetMs: number | undefined,
): ExecResult | null {
  if (consultStartedAt === undefined) return null;
  const budgetMs = evidenceConsultBudgetMs(consultBudgetMs);
  const elapsed = Date.now() - consultStartedAt;
  if (elapsed <= budgetMs) return null;
  return {
    exitCode: -1,
    stdout: "",
    stderr: `EVIDENCE-BUDGET: ${phase} exceeded the cumulative consult budget (${elapsed}ms elapsed > ${budgetMs}ms budget): git ${args.join(" ")}`,
  };
}

/** One armed-and-judged evidence spawn — see `gitEvidence`'s flux ride-out. */
async function gitEvidenceAttempt(
  repoRoot: string,
  args: string[],
  opts?: {
    timeoutMs?: number;
    extraEnv?: Record<string, string>;
    internalEnv?: Record<string, string>;
    preflight?: boolean;
    /** Extra file inodes folded into the spawn-window watch (see `verifierGit`). */
    extraWatchPaths?: readonly string[];
    /** RFC-1633: consult budget clock start (lock acquisition instant). */
    consultStartedAt?: number;
    /** RFC-1633: cumulative preflight+arm+settle bound. */
    consultBudgetMs?: number;
  },
): Promise<ExecResult> {
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
  const preflightBreach = evidenceBudgetBreach(
    args,
    "preflight",
    opts?.consultStartedAt,
    opts?.consultBudgetMs,
  );
  if (preflightBreach !== null) {
    closeEvidenceIndex(preflight);
    return preflightBreach;
  }
  // The spawn-window watch (CX-r22): the judged child opens `.git`
  // metadata inside ITS lifetime — the reprove ends at spawn, not at
  // the child's reads. Arming before the last check and draining after
  // `close` turns a mid-window plant+unlink (shallow/exclude/
  // alternates, loose objects, config/index rewrites, the held claims
  // index via `/proc/<pid>/fd/3`) into a deterministic refusal.
  let windowWatch: ReturnType<typeof armEvidenceWindowWatch> = null;
  if (preflight !== null) {
    // CX-r38-W1: worktree-content consults fold the claims-derived
    // tracked surface (and `check-ignore`'s rule sources) into the
    // armed window — `.git` watches never covered worktree inodes. The
    // plan recompute rides the arm loop so a drift re-preflight binds
    // the FRESH held index, never a stale basis.
    for (let armAttempt = 0; preflight !== null; armAttempt++) {
      const wtArm = resolveWorktreeArm(args, preflight, opts?.extraWatchPaths);
      if (wtArm === null) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `${EVIDENCE_REFUSED_PREFIX}: worktree surface unverifiable — refusing the consult: git ${args.join(" ")}`,
        };
      }
      windowWatch = armEvidenceWindowWatch(
        repoRoot,
        preflight,
        undefined,
        wtArm.extraWatch,
        undefined,
        wtArm.wtPlan,
      );
      if (windowWatch === null) {
        preflight = null;
        break;
      }
      if (reproveEvidenceSurface(repoRoot, preflight)) break;
      await windowWatch.settle();
      windowWatch = null;
      closeEvidenceIndex(preflight);
      preflight = armAttempt >= 1 ? null : await evidencePreflight(repoRoot, preflight.fingerprint);
    }
  }
  const armBreach = evidenceBudgetBreach(
    args,
    "arm",
    opts?.consultStartedAt,
    opts?.consultBudgetMs,
  );
  if (armBreach !== null) {
    if (windowWatch !== null) await windowWatch.settle();
    closeEvidenceIndex(preflight);
    return armBreach;
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
    // Pure-geometry `rev-parse` consults answer in-process from the
    // fingerprint (CX-r36-B): no live consult runs, so no live surface
    // can be forged — and `--is-inside-git-dir` is ONLY answerable
    // this way (an overlay child would compare cwd to the mint path).
    if (reportsRepoGeometry(args)) {
      const local = geometryLocalAnswer(args, preflight, repoRoot);
      if (local !== null) return local;
    }
    // The verifier index is resolved per spawn — fd form carries no
    // path at all (CX-129); the path form re-proves its on-disk bytes
    // before the redirect is trusted. An unproven index (rebuild
    // failed, CX-124, or a rewrite caught just now) refuses
    // index-consulting ops; non-index ops never consult it and proceed.
    // Read consults bind the ref namespace through the verifier-owned
    // overlay (CX-r35-A) — the arm above already minted+pinned it, so a
    // mid-window live-ref flip→restore cannot shape resolution. An
    // overlay the arm failed to mint is `refUnproven` and refuses.
    // Geometry consults bind the same overlay now (CX-r36-B): the
    // sibling-metadir members `worktree list` reads are minted too,
    // and path-shaped answers get the overlay→real substitution below.
    // Mutations the channel legitimately runs (`worktree add` and the
    // bounded scratch set) keep the live gitdir — overlay `GIT_DIR`
    // would land their admin writes inside the copy.
    const overlayRefs = isEvidenceGitQuery(args);
    const spawnState = evidenceSpawnState(preflight, true, overlayRefs);
    if (
      (spawnState.unproven && isIndexConsultingRead(args)) ||
      (spawnState.refUnproven && overlayRefs)
    ) {
      closeSpawnFds(spawnState);
      return {
        exitCode: -1,
        stdout: "",
        stderr: `${EVIDENCE_REFUSED_PREFIX}: evidence unproven (${preflight?.indexUnproven ?? "gitdir overlay unmintable"}): git ${args.join(" ")}`,
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
      boundRoots: spawnState.bindRoots,
      heldRoots: windowWatch?.heldRoots,
    });
    // Any `.git` event inside the armed window means the child may
    // have read an unjudged surface — refuse the verdict regardless of
    // what it printed (CX-r22). The pin layer covers dirent-invisible
    // writes (CX-r23-A); the fingerprint's own compare is the last byte
    // check for the `objects/` tree the pin bound leaves out.
    if (windowWatch !== null) {
      const events = await windowWatch.settle();
      windowWatch = null;
      if (events.length > 0) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `${EVIDENCE_REFUSED_PREFIX}: repository surface mutated during the judged read (${events[0]}${events.length > 1 ? ` +${events.length - 1}` : ""})`,
        };
      }
      if (preflight !== null && !reproveEvidenceSurface(repoRoot, preflight)) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `${EVIDENCE_REFUSED_PREFIX}: repository surface drifted during the judged read`,
        };
      }
    }
    // `cat-file <type> <oid>` serves raw object bytes — re-hash them
    // to the requested name or the consult was forged (CX-r36 belt).
    const cfReq = catFileObjectRequest(args);
    if (cfReq !== null && r.exitCode === 0) {
      const algo = preflight?.objectFormat === "sha256" ? "sha256" : "sha1";
      const served = createHash(algo)
        .update(`${cfReq.type} ${r.stdout.length}\0`)
        .update(r.stdout)
        .digest("hex");
      if (served !== cfReq.oid) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `${EVIDENCE_REFUSED_PREFIX}: served object bytes do not hash to the requested name: git ${args.join(" ")}`,
        };
      }
    }
    const settleBreach = evidenceBudgetBreach(
      args,
      "settle",
      opts?.consultStartedAt,
      opts?.consultBudgetMs,
    );
    if (settleBreach !== null) return settleBreach;
    let stdout = r.stdout.toString();
    if (overlayRefs && reportsRepoGeometry(args) && preflight?.overlay != null) {
      stdout = substituteOverlayPaths(
        stdout,
        preflight.overlay,
        preflight.fingerprint!,
        args,
        r.fdEnv,
      );
    }
    return { exitCode: r.exitCode, stdout, stderr: r.stderr.toString() };
  } finally {
    // The per-call preflight owns its held fds — cached preflights
    // (OriginGit) keep them for the instance's lifetime instead. The
    // watch is per-spawn — always released.
    if (windowWatch !== null) await windowWatch.settle();
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
  const { objectsDir, shapePaths, headBranch, hazards, writeChannels, anyFailed, fingerprint } =
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
  // every spawn on its own. A `hazards` member is the same class one
  // level up — non-regular `.git` metadata anywhere in the consultable
  // surface (CX-r27-C: a `.git/logs/FOO` fifo stalls a child's startup
  // open to the timeout instead of refusing), so it feeds the same
  // unproven flag before any judged spawn.
  const configUnproven =
    hazards.length > 0
      ? `non-regular .git metadata (${hazards.join(", ")}) — git startup reads would block`
      : fingerprint.configPath !== null &&
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
  // Prepared silent write channels the capture's procfs audit found —
  // the bytes they could serve are unprovable (CX-r36/R37).
  preflight.shapeViolations.push(...writeChannels);
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
  const prepared =
    hazards.length > 0
      ? { failure: "non-regular .git metadata — claims enumeration would block" }
      : indexNonRegular
        ? { failure: ".git/index is a non-regular file — claims enumeration would block" }
        : await prepareEvidenceIndex(repoRoot, internalEnv, {
            path: fingerprint.indexPath,
            bytes: fingerprint.indexBytes,
            shared: fingerprint.sharedIndexBytes,
          });
  preflight.index = prepared.index;
  preflight.indexUnproven = prepared.failure;
  preflight.configUnproven = configUnproven;
  preflight.fingerprint = fingerprint;
  // CX-r38-W2 baseline: every path-valued resolution root the armed
  // window holds an fd to gets its inode+ctime captured at PREFLIGHT
  // time — the arm's held-fd open verifies the opened inode against
  // this tuple, so a rename-substituted root landing between capture
  // and arm reads as drift instead of binding the forged inode.
  const rootStats = new Map<string, { ino: number; ctimeMs: number } | null>();
  for (const r of [
    fingerprint.workTree,
    fingerprint.gitDir,
    fingerprint.commonDir,
    fingerprint.objectsDir,
    fingerprint.indexPath === null ? null : dirname(fingerprint.indexPath),
  ]) {
    if (r === null || r === undefined || rootStats.has(r)) continue;
    let st = null;
    try {
      const s = statSync(r);
      st = { ino: s.ino, ctimeMs: s.ctimeMs };
    } catch {
      /* unstatable — no proven baseline, the arm fails closed */
    }
    rootStats.set(r, st);
  }
  fingerprint.rootStats = rootStats;
  // CX-r38-W1 baseline: the worktree surface the consult will read is
  // captured at PREFLIGHT time — the arm's pins then compare against
  // the capture-instant state, so a flip/hide landing between capture
  // and arm reads as drift (the `.git` fingerprint's own semantics)
  // instead of being silently adopted as the pin baseline.
  if (preflight.index?.names !== undefined && fingerprint.workTree !== null) {
    const wt = fingerprint.workTree;
    const surface = captureWorktreeSurface(wt, preflight.index.names);
    // CX-r39 reliability, CX-r41-F1: directories git reports ignored
    // are RECORDED on the surface, not removed — whether a consult may
    // drop them from coverage is a per-argv judgment `resolveWorktreeArm`
    // makes via `consultDescendsIgnoredDirs` (`status` forced `--ignored`
    // and `ls-files -o` post-strip DO descend, `check-ignore` does not).
    // `check-ignore` per dir is the precise boundary —
    // `status --ignored`/`ls-files --directory` collapse also cover
    // unignored dirs whose CONTENTS are all ignored, where `.gitignore`
    // still shapes verdicts. A failed consult leaves the set empty —
    // unproven exclusion never narrows coverage.
    const relDirs = [...surface.dirs.keys()]
      .map((d) => relative(wt, d))
      .filter((r) => r.length > 0);
    const ignored = new Set<string>();
    for (let i = 0; i < relDirs.length; i += 1500) {
      const chunk = relDirs.slice(i, i + 1500);
      const r = await execEvidenceGit(wt, ["check-ignore", "-z", "--stdin"], {
        internalEnv,
        // `check-ignore` stats the worktree for dir arguments — the
        // static pins keep `core.fsmonitor` a session program cannot
        // exec inside the trusted preflight consult (CX-115 class).
        extraEnv: evidencePinEnv(["check-ignore"]),
        // Git ≥2.53 rejects `-z` on the argv form — the chunk must ride
        // stdin NUL-separated or the prune consult always errors and
        // silently never engages (CX-r40-N1).
        input: `${chunk.join("\0")}\0`,
      });
      if (r.exitCode !== 0 && r.exitCode !== 1) break;
      for (const abs of ignoredDirSetFromCheckIgnore(wt, r.stdout)) ignored.add(abs);
    }
    markIgnoredDirs(surface, ignored);
    preflight.worktreeSurface = surface;
  }
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
  // A refused/failed read on a REPO-SHAPED dir is "unverifiable", never
  // "not bare" — the r19 polarity bug let an unproven surface walk past
  // the bare-repository gates in flow.install/flow.check/repo-kind
  // (CX-171). A plain non-repo is a different honest answer: git would
  // exit 128 "not a git repository" — the fs-level repoShaped walk
  // separates the two on the same -1 (CX-151's discriminator), so a
  // folder that was never a repo still reaches the caller's own
  // not-a-repo diagnostic instead of crashing here.
  if (result.exitCode !== 0) {
    if (!repoShaped(repoRoot)) return false;
    throw new Error(
      `git rev-parse --is-bare-repository failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim() === "true";
}

/** Current branch short name; null on detached HEAD (symbolic-ref fails). */
export async function currentBranch(repoRoot: string, _io: WorkspaceIO): Promise<string | null> {
  const result = await gitEvidence(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  // exit -1 is "no git answer" — null would misread an unverifiable repo
  // as detached HEAD (CX-174). On a plain non-repo the channel refuses
  // the same way, and "no branch" is the honest answer there — the
  // repoShaped discriminator separates the two (isBare's pattern).
  if (result.exitCode === -1) {
    if (!repoShaped(repoRoot)) return null;
    throw new Error(
      `git symbolic-ref HEAD produced no answer — the branch is unverifiable: ${result.stderr.trim()}`,
    );
  }
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** True when HEAD has no commit yet (unborn branch). */
export async function isUnborn(repoRoot: string, _io: WorkspaceIO): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]);
  // exit -1 is "no git answer" — `true` would present an unverifiable
  // repo as historyless (CX-174). A non-repo honestly has no history —
  // repoShaped separates it (isBare's pattern). git's own nonzero
  // (--verify -q exits 1 on unborn) stays the honest answer.
  if (result.exitCode === -1) {
    if (!repoShaped(repoRoot)) return true;
    throw new Error(
      `git rev-parse --verify -q HEAD produced no answer — the repo's history is unverifiable: ${result.stderr.trim()}`,
    );
  }
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
  // exit -1 is "no git answer" — null would present an unverifiable ref
  // as missing (CX-174). On a non-repo "missing" is honest — repoShaped
  // separates it.
  if (result.exitCode === -1) {
    if (!repoShaped(repoRoot)) return null;
    throw new Error(
      `git log -1 ${ref} produced no answer — the ref is unverifiable: ${result.stderr.trim()}`,
    );
  }
  return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

export async function branchExists(
  repoRoot: string,
  io: WorkspaceIO,
  name: string,
): Promise<boolean> {
  const result = await gitEvidence(repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
  // exit -1 is "no git answer" — `false` would present an unverifiable
  // ref as absent (CX-174). On a non-repo "absent" is honest — repoShaped
  // separates it. --verify -q exits 1 on a missing branch — that stays
  // the honest false.
  if (result.exitCode === -1) {
    if (!repoShaped(repoRoot)) return false;
    throw new Error(
      `git rev-parse --verify -q refs/heads/${name} produced no answer — the branch is unverifiable: ${result.stderr.trim()}`,
    );
  }
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
  const ignoredClaims: string[] = [];
  for (const line of porcelainLines(result.stdout)) {
    const path = line.slice(3);
    // `!!` entries are hidden-by-rule files — committed `.gitignore`
    // policy excludes them from the verdict, while the session-authored
    // rules below can never silence their own presence (CX-142). A
    // forge-state path under such a rule is still disposable state:
    // RFC-1515 deletes toleratedState before `git worktree remove`, and
    // removing the covering `.gitignore` first would unhide the rest and
    // wedge the removal (FLOW-INT-04). Every `!!` is collected for the
    // rule-source proof below — a `.gitignore` planted inside the
    // child's own lifetime reclassifies `??` payloads as `!!` while the
    // rule source walks/never sees it (CX-r22 worktree side).
    if (line.startsWith("!! ")) {
      ignoredClaims.push(path);
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
  // every rule as session-authored — fail closed. `null` means the
  // worktree toplevel could not be resolved on the channel that JUST
  // answered status — the dirty set is unverifiable, so the verdict
  // must not reach a caller as a clean-ish entry list (CX-167).
  const sessionRules = await sessionIgnoreRulePaths(worktree, async (paths, root) => {
    const r = await gitEvidence(root, ["ls-files", "-z", "--", ...paths]);
    return r.exitCode === 0 ? new Set(r.stdout.split("\0").filter((p) => p.length > 0)) : null;
  });
  if (sessionRules === null) {
    throw new Error(
      `${EVIDENCE_REFUSED_PREFIX}: git status --porcelain succeeded but the worktree toplevel became unresolvable — dirty verdict unverifiable`,
    );
  }
  for (const p of sessionRules) {
    if (entries.some((e) => e.slice(3) === p) || toleratedState.includes(p)) continue;
    // A session-authored rule under `.forge/` can only hide paths the
    // verdict already tolerates (`.gitignore` scope is its own subtree)
    // — it joins toleratedState like every other forge journal path;
    // a root or product-tree rule still counts as blocking dirt.
    if (isForgeStatePath(p)) toleratedState.push(p);
    else entries.push(`?? ${p}`);
  }
  // `!!` provenance (CX-r22): each ignored claim must trace to a
  // TRACKED `.gitignore` — a mid-child plant's source is untracked or
  // gone, so its hidden paths rejoin the verdict as honest `??` dirt.
  // `null` = the provenance channel refused — the dirty set is
  // unverifiable, never a clean-ish list.
  if (ignoredClaims.length > 0) {
    const unproven = await unprovenIgnoredPaths(worktree, ignoredClaims);
    if (unproven === null) {
      throw new Error(
        `${EVIDENCE_REFUSED_PREFIX}: git status --porcelain succeeded but ignored-path rule provenance is unverifiable`,
      );
    }
    for (const p of unproven) {
      if (entries.some((e) => e.slice(3) === p) || toleratedState.includes(p)) continue;
      // An unproven `.forge/` hidden path can only be covered by a
      // `.forge/`-scoped rule — same tolerated partition as session
      // rules and `??` forge-state paths above.
      if (isForgeStatePath(p)) toleratedState.push(p);
      else entries.push(`?? ${p}`);
    }
  }
  return { entries, toleratedState, vanished: false };
}
