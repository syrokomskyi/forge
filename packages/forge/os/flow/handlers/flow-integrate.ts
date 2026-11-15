/*
<MODULE_CONTRACT>
<purpose>flow.integrate — land a registered auto branch on develop
(RFC-1487). Under the integration lock: the branch's worktree must be clean,
the branch rebases onto the current develop, the primary's
hooks/integration-gate.sh gates, the primary must sit clean on develop, and
git -C &lt;primary&gt; merge --ff-only moves develop forward — never a merge
commit. Afterwards the worktree, branch and registry entry are removed and
the journal records the integrate. A rerun after a mid-cleanup crash resumes
at cleanup without moving develop again.</purpose>
<non-goals>
  <item>No push, no release work — the outbound wave owns remote operations.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The integration lock covers steps 1–5 only — cleanup (step 6) is idempotent and needs no serialization, so a crashed holder cannot wedge the queue (AUDIT G2).</item>
  <item>Every git call after worktree removal runs with -C &lt;primary&gt; — the caller's cwd may be the removed directory (AUDIT G3/G4).</item>
  <item>Rerun detection is `isAncestor(branchTip, develop)` on a registered entry — develop already containing the branch means the merge landed; only cleanup remains (AC-9).</item>
  <item>FLOW-INT-07 covers develop moving between rebase and merge despite the lock — the branch stays rebased; a rerun rebases onto the new tip.</item>
  <item>Task-file preservation runs inside the cleanup branch BEFORE the worktree-teardown hook and only for owner.kind task — a `git clean -fdx` teardown would destroy `.forge/task/` first, and a copy failure refuses cleanup (FLOW-INT-04) so the report is never lost with the worktree (RFC-1509 Q-16).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1600: refuse duplicate governance ids at flow.integrate preflight (RFC-1600)

FLOW-INT-19 scans the branch-vs-develop diff for governance id collisions — RFC/ADR/friction file ids and V-*∕RFC-IMP-*∕FLOW-* rule literals — before the rebase and heavyweight gates, refusing with both locations when the same id is claimed at different sites; same-site relands pass. AGENTS.md collision playbook now points at forge/rfc-reservations.yaml; manifest regenerated for the updated rule surface.</item>
  <item>RFC-1599: sweep primary dirt into opened worktrees + bind session writes to the owning checkout (RFC-1599)</item>
  <item>RFC-1598: generated-conflict auto-resolve runs the owner generator inside a detached checked-out side (theirs → ours → take-theirs deferral), never the mixed mid-rebase index (RFC-1598)</item>
  <item>RFC-1597: atomic cut preflight + covers-resume + worktree-bound owner regen (RFC-1597)</item>
  <item>RFC-1602: defer docs.archive owner-regen to the integrate fold and stage bookkeeping atomically

docs.archive recorded ~12-minute inline owner regen blocking session end
(F-0212) and left pnpm-lock.yaml MM after its safety-net restore (F-0245).
The invalidated owner inventory now lands in .git/forge/deferred-regen.json
for flow.integrate's post-rebase fold to sweep (record cleared only when
every owner ran); bookkeeping pathspecs are validated before the first
git add, the lockfile restore gained its index-side counterpart, and a
post-staging sweep surfaces MM residue with the git show : remediation.

RFC-1602</item>
  <history>ADR-0128, ADR-0130, RFC-1487, RFC-1490, RFC-1491, RFC-1504, RFC-1509, RFC-1515, RFC-1528, RFC-1531, RFC-1532, RFC-1536, RFC-1537, RFC-1538, RFC-1543, RFC-1544, RFC-1545, RFC-1574, RFC-1580, RFC-1589</history>
</CHANGE_SUMMARY>
*/

import type {
  CommandRegistry,
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeInvokeCommand,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import {
  AUTO_CLEAN_PASS_CLASSES,
  FOREIGN_PRIMARY_DIRT_HINT,
  SWEEP_COMMIT_SUBJECT,
  classifyDirtyPath,
  classifyDirtyTree,
  summarizeClasses,
} from "../dirty-classify.ts";
import {
  branchExists,
  currentBranch,
  git,
  gitCommit,
  isAncestor,
  requireGit,
  statusDirty,
  statusTracked,
  topLevel,
  worktreeAdd,
  worktreeList,
} from "../git.ts";
import {
  describeHeldLock,
  LockTimeoutError,
  withFlowLock,
  type HeldLockDiagnostic,
} from "../locks.ts";
import {
  appendJournal,
  readJournal,
  commonGitDir,
  FlowRegistrySchemaError,
  INTEGRATE_LOCK_RELATIVE_PATH,
  readRegistry,
  registryPath,
  updateRegistry,
  type FlowRegistryEntry,
} from "../registry.ts";
import { runFlowScript, type FlowScriptResult } from "../scripts.ts";
import {
  deltaChangedPaths,
  gateReportSteps,
  recordPreLockVerdict,
  resolveDeltaStepDomains,
  selectDeltaGateSteps,
  type DeltaGateSelection,
  type IntegrateGateMode,
} from "../pre-lock.ts";
import {
  postRebaseOwners,
  regenerateAfterRebase,
  type PostRebaseRegenResult,
} from "../post-rebase-regen.ts";
import { standaloneInvoke } from "../standalone-invoke.ts";
import { clearDeferredRegen, consumeDeferredRegen } from "../../core/archive-regen.ts";
import { preserveTaskFiles } from "../task-files.ts";
import { flowWorktreePath, primaryWorktree } from "../worktree-path.ts";
import { pruneReservationsForSession } from "../../rfc/next-id.ts";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const INTEGRATE_LOCK_WAIT_MS = 30 * 60_000;
export const INTEGRATE_LOCK_STALE_MS = 2 * 3_600_000;

/** RFC-1515 AC-4: the refused lock attempt reports who holds it. */
export type LockDiagnostic = HeldLockDiagnostic;

export interface FlowIntegrateData {
  branch: string | null;
  integrated: boolean;
  /** develop tip before this invocation. */
  developBefore: string | null;
  /** develop tip after this invocation (same as developBefore on resume/refusal). */
  developAfter: string | null;
  /** A rebase ran during this invocation. */
  rebased: boolean;
  gate: FlowScriptResult | null;
  /** worktree-teardown script result when cleanup ran — never an integration-gate result. */
  teardown?: FlowScriptResult | null;
  cleanedUp: boolean;
  /** RFC-1515: forge-local state paths the cleanliness check tolerated this
   * run — journaled so "tolerated" is auditable, never a suppressed blocker. */
  toleratedState?: string[];
  /** RFC-1537: declared regenerable dirt tolerated this run — {path, class}
   * per classified path; journaled, never committed or silently absorbed. */
  toleratedDirt?: Array<{ path: string; class: string }>;
  /** RFC-1538: "already-integrated" when the branch's work is already in
   * develop and nothing remains to do — idempotent exit, no cleanup run. */
  disposition?: "already-integrated";
  /** RFC-1538: generated-file rebase conflicts auto-resolved via their owner
   * commands — journaled, never silently merged. */
  autoResolved?: string[];
  /** RFC-1598: autoResolved paths resolved by take-theirs on an uncheckable
   * side — correctness defers to the post-rebase regen fold. */
  autoResolveDeferred?: string[];
  /** RFC-1574: post-rebase regeneration of derived manifests (step 3b). */
  postRebaseRegen?: PostRebaseRegenResult;
  /** RFC-1538: which checkout's build ran the integration gate. */
  gateEngine?: "session" | "primary";
  /** RFC-1580: the primary install's correctness.gate verdict for this integration. */
  correctnessGate?: { status: string; bundlePath: string | null; acceptedWeakening: string | null };
  /** RFC-1531: worktree path --reattach created this run. */
  reattachedTo?: string;
  /** RFC-1531: reattach target a --dry-run reports without mutating. */
  wouldReattach?: string;
  /** RFC-1531: disposable-class paths --auto-clean deleted this run. */
  autoCleaned?: string[];
  /** RFC-1531: sha of the --autocommit sweep commit (SWEEP_COMMIT_SUBJECT). */
  autocommitSha?: string;
  /** RFC-1544: foreign-open-mission importer ids restored into the lockfile. */
  restoredImporters?: string[];
  /** RFC-1544: sha of the stale-importer prune commit, when one was written. */
  staleImporterCommitSha?: string;
  /** RFC-1515: holder payload when FLOW-INT-08 refused on a held lock. */
  lock?: LockDiagnostic;
  /** RFC-1589: how the integration gate ran — unset on the legacy
   * under-lock sequence (pre-lock machinery not engaged). */
  gateMode?: IntegrateGateMode;
  /** RFC-1589: wall time the integration lock was held this run — the
   * pre-lock comparison metric; unset on the legacy path. */
  lockHeldMs?: number;
  /** RFC-1589: Phase-A runs this integrate needed (1 unless develop moved
   * or the branch state went stale and the attempt was discarded). */
  preLockAttempts?: number;
  /** RFC-1589: the locked-delta step selection computed from the develop
   * delta — recorded for audit; the real gate's own RFC-1582 selection
   * decides which rows actually ran. */
  deltaSelection?: DeltaGateSelection;
  diagnostics: Diagnostic[];
}

/** RFC-1599 FLOW-INT-20: primary tracked dirt coexisting with a live
 * session — an audit warning on the pass path and beside FLOW-INT-03
 * refusals; never itself the refusal cause. */
function foreignDirtWarning(
  rows: Array<{ path: string; owningSession: string | null }>,
): Diagnostic {
  return {
    ruleId: "FLOW-INT-20",
    severity: "warning",
    message:
      `primary checkout carries ${rows.length} tracked mutation(s) while a live session exists: ` +
      rows
        .slice(0, 10)
        .map((f) => (f.owningSession !== null ? `${f.path} (${f.owningSession})` : f.path))
        .join(", ") +
      (rows.length > 10 ? ` (+${rows.length - 10} more)` : ""),
    fixHint: FOREIGN_PRIMARY_DIRT_HINT,
  };
}

function refuse(
  ruleId: string,
  message: string,
  fixHint: string,
  partial?: Partial<FlowIntegrateData>,
  diagData?: Record<string, unknown>,
): FlowIntegrateData {
  return {
    branch: partial?.branch ?? null,
    integrated: partial?.integrated ?? false,
    developBefore: partial?.developBefore ?? null,
    developAfter: partial?.developAfter ?? partial?.developBefore ?? null,
    rebased: partial?.rebased ?? false,
    gate: partial?.gate ?? null,
    cleanedUp: partial?.cleanedUp ?? false,
    ...(partial?.toleratedState !== undefined ? { toleratedState: partial.toleratedState } : {}),
    ...(partial?.toleratedDirt !== undefined ? { toleratedDirt: partial.toleratedDirt } : {}),
    ...(partial?.reattachedTo !== undefined ? { reattachedTo: partial.reattachedTo } : {}),
    ...(partial?.autoCleaned !== undefined ? { autoCleaned: partial.autoCleaned } : {}),
    ...(partial?.autocommitSha !== undefined ? { autocommitSha: partial.autocommitSha } : {}),
    ...(partial?.restoredImporters !== undefined
      ? { restoredImporters: partial.restoredImporters }
      : {}),
    ...(partial?.staleImporterCommitSha !== undefined
      ? { staleImporterCommitSha: partial.staleImporterCommitSha }
      : {}),
    ...(partial?.lock !== undefined ? { lock: partial.lock } : {}),
    diagnostics: [
      { ruleId, severity: "error", message, fixHint, ...(diagData ? { data: diagData } : {}) },
    ],
  };
}

/**
 * ADR-0128 (F-0188): FLOW-INT-02 always carries an actionable cause.
 * Unmerged paths are capped at 20 with a (+N more) tail; when the rebase
 * failed without unmerged paths the message names the cause instead —
 * the rebase stderr tail plus the worktree's porcelain status.
 */
async function rebaseConflictRefusal(
  branchWorktree: string,
  io: WorkspaceIO,
  rebase: { stderr?: string; stdout?: string },
  paths: string[],
  partial: Partial<FlowIntegrateData>,
  messageSuffix = "",
): Promise<FlowIntegrateData> {
  const porcelain = await git(branchWorktree, io, ["status", "--porcelain"]);
  const statusPorcelain = porcelain.stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(0, 20);
  const stderrLines = (rebase.stderr ?? rebase.stdout ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const rebaseStderrTail = stderrLines.slice(-20);
  let message: string;
  let fixHint: string;
  if (paths.length > 0) {
    const shown = paths.slice(0, 20);
    const more = paths.length - shown.length;
    message = `rebase onto develop conflicts in: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}${messageSuffix}`;
    fixHint =
      "resolve the listed conflicts in the session worktree, commit, and re-run flow.integrate";
  } else {
    const cause =
      rebaseStderrTail.length > 0
        ? `rebase stderr tail: ${rebaseStderrTail.join(" | ")}`
        : "no unmerged paths and empty rebase output";
    const dirt =
      statusPorcelain.length > 0
        ? `worktree status: ${statusPorcelain.join(" | ")}`
        : "worktree status: clean";
    message = `rebase onto develop failed without unmerged paths — ${cause} — ${dirt}${messageSuffix}`;
    fixHint = "clean the listed worktree state, then re-run flow.integrate";
  }
  return refuse("FLOW-INT-02", message, fixHint, partial, {
    conflictedPaths: paths,
    rebaseStderrTail,
    statusPorcelain,
  });
}

async function resolveEntry(
  repoRoot: string,
  io: WorkspaceIO,
  branch: string,
): Promise<{ common: string; entry: FlowRegistryEntry } | { common: string; entry: null }> {
  const common = await commonGitDir(io, repoRoot);
  const registry = await readRegistry(io, common);
  return { common, entry: registry.branches.find((b) => b.name === branch) ?? null };
}

/** Step 6 — teardown, worktree removal, branch delete, registry, journal. */
async function cleanupIntegrated(
  primary: string,
  worktree: string | null,
  entry: FlowRegistryEntry,
  common: string,
  sha: string,
  io: WorkspaceIO,
  nowIso: string,
  journalEvent: "integrate" | "backmerge" = "integrate",
  journalBase?: string,
  journalToleratedDirt?: Array<{ path: string; class: string }>,
  journalAutoResolved?: string[],
  journalRemediation?: {
    reattachedTo?: string;
    autoCleaned?: string[];
    autocommitSha?: string;
    restoredImporters?: string[];
    staleImporterCommitSha?: string;
  },
  journalGateReport?: string,
  journalGateMode?: { gateMode: string; lockHeldMs: number; preLockAttempts: number },
): Promise<{ cleanedUp: boolean; diagnostics: Diagnostic[]; gate: FlowScriptResult | null }> {
  const branchExistsNow = await branchExists(primary, io, entry.name);
  let teardownRan: FlowScriptResult | null = null;
  let toleratedPaths: string[] = [];
  if (worktree !== null && (await io.exists(worktree))) {
    // RFC-1509 Q-16: preserve BEFORE the teardown hook — a `git clean -fdx`
    // teardown would destroy .forge/task/ with the rest of the worktree.
    if (entry.owner.kind === "task") {
      try {
        await preserveTaskFiles(common, worktree, entry.owner.id, io);
      } catch (error) {
        return {
          cleanedUp: false,
          gate: null,
          diagnostics: [
            {
              ruleId: "FLOW-INT-04",
              severity: "error",
              message: `could not preserve .forge/task/ for ${entry.owner.id}: ${error instanceof Error ? error.message : String(error)}`,
              fixHint: `copy ${worktree}/.forge/task/ aside by hand, then re-run flow.integrate — develop already moved`,
            },
          ],
        };
      }
    }
    const teardown = await runFlowScript(io, "worktree-teardown", {
      primary,
      cwd: worktree,
      env: { FLOW_PRIMARY: primary, FLOW_BRANCH: entry.name, FLOW_ACTION: "integrate" },
    });
    teardownRan = teardown;
    if (teardown.status === "failed") {
      return {
        cleanedUp: false,
        gate: teardown,
        diagnostics: [
          {
            ruleId: "FLOW-INT-04",
            severity: "error",
            message: `hooks/worktree-teardown.sh refused cleanup (exit ${teardown.exitCode}): ${teardown.stderrTail}`,
            fixHint: `resolve what ${primary}/hooks/worktree-teardown.sh demands, then re-run flow.integrate — develop already moved`,
          },
        ],
      };
    }
    // RFC-1515: `statusDirty` predicts `git worktree remove` — allowlisted
    // forge-local state is untracked-not-ignored, so a tolerated-only tree
    // still refuses removal. Delete the tolerated paths first (declared-
    // disposable state; task payloads are already preserved above); a
    // fresh check showing real entries leaves remove to report them.
    const residual = await statusDirty(worktree, io);
    if (residual.entries.length === 0 && residual.toleratedState.length > 0) {
      toleratedPaths = residual.toleratedState;
      for (const rel of residual.toleratedState) {
        await rm(join(worktree, rel), { force: true, recursive: true });
      }
    }
    const remove = await git(primary, io, ["worktree", "remove", worktree]);
    if (remove.exitCode !== 0) {
      return {
        cleanedUp: false,
        gate: teardown,
        diagnostics: [
          {
            ruleId: "FLOW-INT-04",
            severity: "error",
            message: `git worktree remove ${worktree} failed: ${remove.stderr.trim()}`,
            fixHint: `clear the blocker (dirty files, locks) and re-run flow.integrate to finish cleanup`,
          },
        ],
      };
    }
  }
  if (branchExistsNow) {
    // RFC-1515: a vanished worktree leaves a stale `git worktree`
    // registration that pins the branch — prune it before deletion. Merged
    // state is already proven by isAncestor, so `-D` is the verified delete
    // (`-d` re-derives containment in the current worktree context, which
    // the F-0093 *.stale race corrupted).
    if (worktree !== null && !(await io.exists(worktree))) {
      await git(primary, io, ["worktree", "prune"]);
    }
    const del = await git(primary, io, ["branch", "-D", entry.name]);
    if (del.exitCode !== 0) {
      return {
        cleanedUp: false,
        gate: teardownRan,
        diagnostics: [
          {
            ruleId: "FLOW-INT-04",
            severity: "error",
            message: `git branch -d ${entry.name} failed: ${del.stderr.trim()}`,
            fixHint: `verify ${entry.name} is merged into develop, then re-run flow.integrate`,
          },
        ],
      };
    }
  }
  try {
    await updateRegistry(io, common, (r) => ({
      ...r,
      branches: r.branches.filter((b) => b.name !== entry.name),
    }));
    await appendJournal(io, common, {
      at: nowIso,
      event: journalEvent,
      branch: entry.name,
      sha,
      detail: journalEvent === "backmerge" ? `back-merged into develop` : `integrated into develop`,
      base: journalBase,
      ...(toleratedPaths.length > 0 ? { toleratedState: toleratedPaths } : {}),
      ...(journalToleratedDirt !== undefined && journalToleratedDirt.length > 0
        ? { toleratedDirt: journalToleratedDirt }
        : {}),
      ...(journalAutoResolved !== undefined && journalAutoResolved.length > 0
        ? { autoResolved: journalAutoResolved }
        : {}),
      ...(journalRemediation?.reattachedTo !== undefined
        ? { reattachedTo: journalRemediation.reattachedTo }
        : {}),
      ...(journalRemediation?.autoCleaned !== undefined && journalRemediation.autoCleaned.length > 0
        ? { autoCleaned: journalRemediation.autoCleaned }
        : {}),
      ...(journalRemediation?.autocommitSha !== undefined
        ? { autocommitSha: journalRemediation.autocommitSha }
        : {}),
      ...(journalRemediation?.restoredImporters !== undefined &&
      journalRemediation.restoredImporters.length > 0
        ? { restoredImporters: journalRemediation.restoredImporters }
        : {}),
      ...(journalRemediation?.staleImporterCommitSha !== undefined
        ? { staleImporterCommitSha: journalRemediation.staleImporterCommitSha }
        : {}),
      ...(journalGateReport !== undefined ? { gateReport: journalGateReport } : {}),
      ...(journalGateMode !== undefined ? journalGateMode : {}),
    });
  } catch (error) {
    if (error instanceof LockTimeoutError || error instanceof FlowRegistrySchemaError) {
      return {
        cleanedUp: false,
        gate: teardownRan,
        diagnostics: [
          {
            ruleId: "FLOW-07",
            severity: "error",
            message: error.message,
            fixHint: `repair or remove ${registryPath(common)} — develop already moved; re-run flow.integrate to finish cleanup`,
          },
        ],
      };
    }
    throw error;
  }
  return { cleanedUp: true, gate: teardownRan, diagnostics: [] };
}

/**
 * Core of flow.integrate — callable with an injected clock. Refusal paths
 * return diagnostics; `integrated`/`cleanedUp` report what really happened.
 * The exported wrapper journals every refusal (RFC-1537); this attempt body
 * stays pure.
 */
export async function integrateFlowBranch(
  repoRoot: string,
  io: WorkspaceIO,
  opts: Parameters<typeof integrateFlowBranchAttempt>[2],
): Promise<FlowIntegrateData> {
  const data = await integrateFlowBranchAttempt(repoRoot, io, opts);
  const error = data.diagnostics.find((d) => d.severity === "error");
  if (error !== undefined && data.branch !== null) {
    // Best-effort bookkeeping — a journal write failure never adds a refusal.
    try {
      const common = await commonGitDir(io, repoRoot);
      const sha =
        (
          await git(repoRoot, io, ["rev-parse", "--verify", "-q", `refs/heads/${data.branch}`])
        ).stdout.trim() || "unknown";
      await appendJournal(io, common, {
        event: "integrate-refusal",
        branch: data.branch,
        sha,
        detail: error.message,
        rule: error.ruleId,
        ...(data.toleratedState !== undefined ? { toleratedState: data.toleratedState } : {}),
        ...(data.toleratedDirt !== undefined ? { toleratedDirt: data.toleratedDirt } : {}),
        // RFC-1532: the refused attempt's report links here too — the journal
        // answers "which gate report belongs to this refusal" in one field.
        ...(data.gate?.reportPath ? { gateReport: data.gate.reportPath } : {}),
      });
    } catch {
      /* journal is audit, not gate */
    }
  }
  return data;
}

interface IntegrateAttemptOpts {
  branch: string | null;
  dryRun: boolean;
  now?: Date;
  onProgress?: (m: string) => void;
  /** Caller already holds the integration lock (flow.cut/fix releases). */
  lockHeld?: boolean;
  /** Test seam — shrink the lock-wait budget so a held lock refuses fast. */
  lockWaitMs?: number;
  /** Gate target — passed to the integration gate as FORGE_FLOW_TARGET. */
  target?: "develop" | "main";
  /** RFC-1528: kernel invoke port for the bounded preflight validators. */
  invoke?: ForgeInvokeCommand;
  /** RFC-1597 (F-0273): the workspace root `invoke` is bound to — defaults to
   * `repoRoot`. Owner commands that WRITE (rebase auto-resolve, post-rebase
   * regen) only use it when it equals the target worktree; an invoke bound
   * elsewhere lands generated output in the wrong checkout. Read-only
   * preflight validators keep the bound root regardless. */
  invokeRoot?: string;
  /** RFC-1598 (F-0243): generator port bound to a checked-out conflict side.
   * The rebase auto-resolver materializes `theirs`/`ours` into a detached
   * side checkout and invokes owner commands THERE — never against the
   * mixed mid-rebase index — so a generator that resolves a module graph
   * sees a consistent tree. Production binds `standaloneInvoke`; tests pass
   * a stub factory bound to the side dir. */
  sideInvoke?: (sideDir: string) => ForgeInvokeCommand;
  /** RFC-1528: command registry for preflight resolvability. */
  commandRegistry?: CommandRegistry;
  /** RFC-1531: recreate a vanished registered worktree inside the lock. */
  reattach?: boolean;
  /** RFC-1531: delete disposable-classified dirty paths, then re-evaluate. */
  autoClean?: boolean;
  /** RFC-1531: sweep remaining dirty entries into a fixed-subject commit. */
  autocommit?: boolean;
  /** RFC-1543: seconds to wait for live foreign claim-holders on primary (default 600, 0 = fail-fast). */
  waitForeignSeconds?: number;
  /** RFC-1580: operator-accepted weakening reason (isolated weakening session only). */
  acceptWeakening?: string;
  /** RFC-1589: run the expensive gate steps BEFORE acquiring integrate.lock
   * (FORGE_INTEGRATE_PRELOCK=1). Non-port entries only — port keeps the
   * under-lock sequence, as does a caller-held lock. */
  preLock?: boolean;
  /** RFC-1589 test seam — replace the develop-delta step selection. */
  deltaGateSelector?: (deltaPaths: string[]) => Promise<{ selected: string[]; total: number }>;
}

/** Everything the unlocked gate phase produced that the locked tail or a
 * restart needs — the pre-lock verdict's coverage record. */
interface IntegrateGateState {
  branch: string;
  entry: FlowRegistryEntry;
  branchWorktree: string;
  /** develop tip when the sequence started (data.developBefore). */
  developBefore: string;
  /** The base the branch rebased onto and the gate diffed against (B0). */
  rebaseBase: string;
  /** Post-gate branch tip the recorded pre-lock verdict covers. */
  branchTip: string;
  dirtyToleratedState: string[];
  toleratedDirt: Array<{ path: string; class: string }>;
  autoResolved: string[];
  /** RFC-1598: subset of autoResolved resolved by take-theirs on an
   * uncheckable side — defers correctness to the post-rebase regen fold. */
  autoResolveDeferred?: string[];
  postRebaseRegen?: PostRebaseRegenResult;
  reattachedTo?: string;
  autoCleaned?: string[];
  autocommitSha?: string;
  restoredImporters?: string[];
  staleImporterCommitSha?: string;
  gate: FlowScriptResult;
  engine: { source: "session" | "primary"; root: string };
  warnings: Diagnostic[];
  correctness: {
    status: string;
    bundlePath: string | null;
    acceptedWeakening: string | null;
  };
}

/** The gate phase either produced a complete (refused/done) integrate data
 * or a ready state the merge tail or locked phase continues from. */
type GatePhaseResult = FlowIntegrateData | { kind: "ready"; state: IntegrateGateState };

/** RFC-1589: Phase-A attempts are bounded — two discards force locked-full. */
const MAX_PRELOCK_ATTEMPTS = 3;

type LockedPhaseResult =
  | { kind: "restart" }
  | {
      kind: "result";
      data: FlowIntegrateData;
      mode: IntegrateGateMode;
      lockHeldMs: number;
      deltaSelection?: DeltaGateSelection;
    };

async function integrateFlowBranchAttempt(
  repoRoot: string,
  io: WorkspaceIO,
  opts: IntegrateAttemptOpts,
): Promise<FlowIntegrateData> {
  const now = opts.now ?? new Date();

  const branch = opts.branch ?? (await currentBranch(repoRoot, io));
  if (branch === null) {
    return refuse(
      "FLOW-INT-06",
      "no --branch given and the current worktree is not on a branch",
      "pass --branch auto/<kind>-<YYMMDD>-<NN>-<slug> explicitly",
    );
  }

  let resolved: Awaited<ReturnType<typeof resolveEntry>>;
  try {
    resolved = await resolveEntry(repoRoot, io, branch);
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      return refuse(
        "FLOW-07",
        error.message,
        `repair or remove ${registryPath(await commonGitDir(io, repoRoot))}`,
      );
    }
    throw error;
  }
  const { common, entry } = resolved;
  if (entry === null) {
    // RFC-1538: a second integrate after a successful one finds no entry —
    // report "already-integrated" (exit 0) instead of FLOW-INT-06 when the
    // journal proves the branch landed or develop already contains its tip.
    let contained = false;
    try {
      const journal = await readJournal(io, common);
      contained = journal.some(
        (e) => e.branch === branch && (e.event === "integrate" || e.event === "backmerge"),
      );
    } catch {
      contained = false;
    }
    if (!contained && (await branchExists(repoRoot, io, branch))) {
      const tip = (await git(repoRoot, io, ["rev-parse", branch])).stdout.trim();
      contained = await isAncestor(repoRoot, io, tip, "develop");
    }
    if (contained) {
      return {
        branch,
        integrated: true,
        developBefore: null,
        developAfter: null,
        rebased: false,
        gate: null,
        cleanedUp: true,
        disposition: "already-integrated",
        diagnostics: [],
      };
    }
    return refuse(
      "FLOW-INT-06",
      `${branch} is not a registered session/task branch`,
      "register it with flow.open, or check flow.status for live entries",
      { branch },
    );
  }
  if (entry.kind === "fix") {
    return refuse(
      "FLOW-INT-06",
      `${branch} is a fix branch — fix branches integrate into main only through a fix release`,
      "run flow.cut inside the fix worktree (or --branch <fix branch>)",
      { branch },
    );
  }
  if (entry.held !== null) {
    return refuse(
      "FLOW-INT-11",
      `${branch} is held (${entry.held.riskCategory}): ${entry.held.reason}`,
      "run flow.unhold to return it to the normal integrate path",
      { branch },
    );
  }

  const primary = await primaryWorktree(io, repoRoot);
  const lockPath = join(common, INTEGRATE_LOCK_RELATIVE_PATH);

  if (opts.dryRun) {
    const live = await worktreeList(primary, io);
    const wtPath = live.find((w) => w.branch === branch)?.path ?? entry.worktree;
    if (wtPath === null || !(await io.exists(wtPath))) {
      // RFC-1531: report the reattach target --reattach would use — nothing
      // is created under --dry-run (AC-7).
      const wouldReattach =
        opts.reattach === true
          ? entry.worktree !== null && (await io.exists(dirname(entry.worktree)))
            ? entry.worktree
            : flowWorktreePath(primary, branch)
          : undefined;
      return {
        branch,
        integrated: false,
        developBefore: null,
        developAfter: null,
        rebased: false,
        gate: null,
        cleanedUp: false,
        ...(wouldReattach !== undefined ? { wouldReattach } : {}),
        diagnostics: [
          {
            ruleId: "FLOW-07",
            severity: "error",
            message:
              `registry entry for ${branch} names worktree ${wtPath}, which does not exist (vanished)` +
              (wouldReattach !== undefined
                ? ` — --reattach would recreate it at ${wouldReattach}`
                : ""),
            fixHint:
              "re-run with --reattach to recreate the worktree at its recorded path, or run flow.discard to drop the registry entry and force-delete the branch",
            data: { vanished: true, ...(wouldReattach !== undefined ? { wouldReattach } : {}) },
          },
        ],
      };
    }
    const dirty = await statusDirty(wtPath, io);
    // RFC-1531: the dry-run diagnostic carries the classified dirty set so
    // the operator reads the remedy (--auto-clean scope) without mutating.
    const classified = classifyDirtyTree(dirty.entries);
    const disposable = classified.filter((c) => c.class === "disposable").map((c) => c.path);
    return {
      branch,
      integrated: false,
      developBefore: null,
      developAfter: null,
      rebased: false,
      gate: null,
      cleanedUp: false,
      ...(dirty.toleratedState.length > 0 ? { toleratedState: dirty.toleratedState } : {}),
      diagnostics:
        dirty.entries.length > 0
          ? [
              {
                ruleId: "FLOW-INT-01",
                severity: "error",
                message:
                  `worktree ${wtPath} has ${dirty.entries.length} uncommitted change(s)` +
                  (dirty.toleratedState.length > 0
                    ? ` — tolerated forge-local state: ${dirty.toleratedState.join(", ")}`
                    : ""),
                fixHint:
                  "commit or revert the uncommitted changes inside the session worktree, or remediate with --auto-clean / --autocommit, then re-run",
                data: {
                  entries: classified,
                  classes: summarizeClasses(classified),
                  toleratedState: dirty.toleratedState,
                  ...(opts.autoClean === true ? { wouldAutoClean: disposable } : {}),
                  ...(opts.autocommit === true ? { wouldAutocommit: true } : {}),
                },
              },
            ]
          : [],
    };
  }

  await io.mkdir(join(common, "forge"));

  // Steps 0–5 under the integration lock (or inside the caller's lock when
  // lockHeld — flow.cut holds it across the whole release).
  //
  // RFC-1589: the sequence is factored into integrateGatePhase (everything
  // up to and including the correctness gate) + integrateMergeTail (the
  // primary-clean check and fast-forward) so FORGE_INTEGRATE_PRELOCK can
  // run the expensive phase before acquiring integrate.lock and hold the
  // lock only for revalidation, a develop-delta gate, and the merge.
  const rebaseOnto = async (
    worktree: string,
    target: string,
    partial: { branch: string; developBefore: string },
  ): Promise<FlowIntegrateData | { autoResolved: string[]; autoResolveDeferred: string[] }> => {
    const autoResolved: string[] = [];
    const autoResolveDeferred: string[] = [];
    let rebase = await git(worktree, io, ["rebase", target]);
    let guard = 0;
    while (rebase.exitCode !== 0 && guard++ < 8) {
      const conflicts = await git(worktree, io, ["diff", "--name-only", "--diff-filter=U"]);
      const paths = conflicts.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const { classifyRebaseConflicts } = await import("../preflight.ts");
      const verdict = await classifyRebaseConflicts(worktree, io, paths);
      const resolvable =
        paths.length > 0 &&
        verdict.nonGenerated.length === 0 &&
        verdict.owners.length === paths.length;
      if (!resolvable) {
        await git(worktree, io, ["rebase", "--abort"]);
        return rebaseConflictRefusal(
          worktree,
          io,
          rebase,
          paths,
          partial,
          verdict.owners.length > 0 ? " — mixed generated/non-generated conflict set" : "",
        );
      }
      // RFC-1598 (F-0243): run each owner generator inside a fully
      // checked-out side — never against the mixed mid-rebase index, where
      // a module-resolving generator loads a broken graph. `theirs`
      // (REBASE_HEAD, the branch commit being replayed) is preferred
      // because the branch's tooling produced the artifact; `ours` (the
      // rebase target tip) is the fallback. The side checkout lands inside
      // the worktree so `pnpm exec` resolves the worktree's install while
      // the checked-out pnpm-workspace.yaml keeps the spawned engine bound
      // to the side tree. A side the generator cannot run on falls through
      // to the next; a side whose generator ran and refused fails hard.
      const sideInvoke = (dir: string) =>
        opts.sideInvoke?.(dir) ??
        standaloneInvoke(
          io,
          dir,
          verdict.owners.map((o) => o.command),
        );
      let lastGenError: string | null = null;
      let resolved = false;
      const sides: Array<{ name: "theirs" | "ours"; ref: string }> = [
        { name: "theirs", ref: "REBASE_HEAD" },
        { name: "ours", ref: target },
      ];
      for (const side of sides) {
        const sha = await git(worktree, io, ["rev-parse", side.ref]);
        if (sha.exitCode !== 0) continue;
        const sideDir = join(worktree, `.flow-side-${side.name}-${guard}`);
        // A crashed earlier integrate can leave the dir behind — clear it
        // so the checkout attempt does not defer on stale residue.
        await io.rm(sideDir, { recursive: true }).catch(() => undefined);
        await git(worktree, io, ["worktree", "prune"]);
        const add = await git(worktree, io, [
          "worktree",
          "add",
          "--detach",
          sideDir,
          sha.stdout.trim(),
        ]);
        if (add.exitCode !== 0) continue;
        try {
          const invoker = sideInvoke(sideDir);
          let sideFailed = false;
          const staged: string[] = [];
          for (const o of verdict.owners) {
            const regen = await invoker(o.command, o.flags);
            if (regen.ok === false || (regen.exitCode !== undefined && regen.exitCode !== 0)) {
              lastGenError = `${o.path}: ${o.command} — ${regen.summary ?? `exit ${regen.exitCode}`}`;
              sideFailed = true;
              break;
            }
            let regenerated: string;
            try {
              regenerated = await io.readFile(join(sideDir, o.path));
            } catch {
              lastGenError = `${o.path}: ${o.command} produced no output on the ${side.name} side`;
              sideFailed = true;
              break;
            }
            // RFC-1545 AC-4: a successful generator that left conflict
            // markers behind must not be committed — escalate like a
            // failure.
            if (/^(<{7}|={7}|>{7})/m.test(regenerated)) {
              lastGenError = `${o.path}: ${o.command} left conflict markers in the regenerated output`;
              sideFailed = true;
              break;
            }
            await io.writeFile(join(worktree, o.path), regenerated);
            await git(worktree, io, ["add", "--", o.path]);
            opts.onProgress?.(
              `conflict: ${o.path} — regenerated via ${o.command} on the ${side.name} side`,
            );
            staged.push(o.path);
          }
          if (!sideFailed) {
            autoResolved.push(...staged);
            resolved = true;
            break;
          }
        } finally {
          await git(worktree, io, ["worktree", "remove", "--force", sideDir]);
        }
      }
      if (!resolved && lastGenError === null) {
        // Neither side could be checked out — take-theirs and defer
        // correctness to the post-rebase regen fold (RFC-1598 AC-4).
        for (const o of verdict.owners) {
          // `git checkout --theirs` is blocked by the agent-session git
          // wrapper — materialize the stage-3 (theirs) blob through the
          // read-only `git show` + io write instead (RFC-1545).
          const theirs = await git(worktree, io, ["show", `:3:${o.path}`]);
          if (theirs.exitCode === 0) {
            await io.writeFile(join(worktree, o.path), theirs.stdout);
          }
          await git(worktree, io, ["add", "--", o.path]);
          autoResolved.push(o.path);
          autoResolveDeferred.push(o.path);
        }
        opts.onProgress?.(
          `conflict: ${paths.join(", ")} — no side checkable; took theirs, deferring regeneration to post-rebase fold`,
        );
      }
      if (!resolved && lastGenError !== null) {
        await git(worktree, io, ["rebase", "--abort"]);
        return refuse(
          "FLOW-INT-02",
          `auto-resolve of generated conflict failed: ${lastGenError}`,
          "resolve the rebase inside the session worktree manually, commit, and re-run flow.integrate",
          partial,
        );
      }
      rebase = await git(worktree, io, ["-c", "core.editor=true", "rebase", "--continue"]);
    }
    if (rebase.exitCode !== 0) {
      const conflicts = await git(worktree, io, ["diff", "--name-only", "--diff-filter=U"]);
      const paths = conflicts.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      await git(worktree, io, ["rebase", "--abort"]);
      return rebaseConflictRefusal(worktree, io, rebase, paths, partial);
    }
    return { autoResolved, autoResolveDeferred };
  };

  const regenManifests = async (
    worktree: string,
    partial: { branch: string; developBefore: string; rebased: boolean },
  ): Promise<PostRebaseRegenResult | FlowIntegrateData | null> => {
    const owners = await postRebaseOwners(worktree, io);
    // RFC-1602: docs.archive defers its invalidated owner inventory into
    // .git/forge/deferred-regen.json — the fold sweeps it here so the
    // archive command returns in seconds. Deferred owners carry their
    // recorded flags; their full artifact path set joins the owned set.
    const deferred = await consumeDeferredRegen({
      workspaceRoot: worktree,
      exec: (command, args, cmdOpts) => io.exec(command, args, { cwd: worktree, ...cmdOpts }),
    });
    const extraOwnedPaths: string[] = [];
    if (deferred) {
      for (const owner of deferred.record.owners) {
        const ownedPaths = owner.artifactPaths.filter((p) => !p.includes("*"));
        extraOwnedPaths.push(...ownedPaths);
        if (!owners.some((o) => o.command === owner.command)) {
          owners.push({
            path: ownedPaths[0] ?? owner.command,
            command: owner.command,
            flags: owner.flags,
          });
        }
      }
      owners.sort(
        (a, b) =>
          Number(a.command === "ecosystem.manifest.generate") -
          Number(b.command === "ecosystem.manifest.generate"),
      );
    }
    if (owners.length === 0) return null;
    // RFC-1597 (F-0273): the kernel invoke port runs owner commands at the
    // CALLER's workspace root — for flow.cut and any primary-side integrate
    // that root is the primary, so generated writes land there uncommitted
    // while the worktree fold sees no diff (and step (5) then refuses
    // FLOW-INT-03 on the heal's own collateral). The kernel invoke is used
    // only when the caller IS this worktree; otherwise the standalone spawn
    // targets the worktree directly — skipped when it cannot run there.
    const kernelBoundHere = opts.invoke !== undefined && (opts.invokeRoot ?? repoRoot) === worktree;
    const invoker = kernelBoundHere
      ? opts.invoke!
      : standaloneInvoke(io, worktree, [
          ...owners.map((o) => o.command),
          "ecosystem.manifest.validate",
        ]);
    // RFC-1574: the standalone fallback spawns `pnpm exec werkstatt run`
    // in the worktree — without an engine build there it cannot run, and
    // the owners are skipped rather than refused.
    const notRunnable =
      !kernelBoundHere && !(await io.exists(join(worktree, "node_modules", ".bin", "werkstatt")))
        ? new Set(owners.map((o) => o.command))
        : undefined;
    const regen = await regenerateAfterRebase({
      branchWorktree: worktree,
      io,
      invoke: invoker,
      owners,
      extraOwnedPaths,
      onProgress: opts.onProgress,
      ...(notRunnable ? { notRunnable } : {}),
    });
    if ("refused" in regen) {
      return refuse("FLOW-INT-12", regen.message, regen.fixHint, partial);
    }
    // Consume the record only when every deferred owner actually ran — a
    // notRunnable-skipped owner keeps the record for a runnable fold.
    if (deferred) {
      const pending = deferred.record.owners.filter((o) => !regen.ran.includes(o.command));
      if (pending.length === 0) {
        clearDeferredRegen(deferred.file);
      } else {
        opts.onProgress?.(
          `deferred regen: ${pending.map((o) => o.command).join(", ")} skipped here — record kept for a runnable fold`,
        );
      }
    }
    return regen;
  };

  const integrateGatePhase = async (gateModeEnv?: IntegrateGateMode): Promise<GatePhaseResult> => {
    const developBefore = (await git(primary, io, ["rev-parse", "develop"])).stdout.trim();
    const hasBranch = await branchExists(primary, io, branch);

    // Rerun/resume: develop already contains the branch tip (or the
    // branch ref is gone) — nothing to move; clean up outside the lock.
    let resume = !hasBranch;
    let branchTip: string | null = null;
    if (hasBranch) {
      branchTip = (await git(primary, io, ["rev-parse", branch])).stdout.trim();
      resume = await isAncestor(primary, io, branchTip, "develop");
    }
    if (resume) {
      return {
        branch,
        integrated: true,
        developBefore,
        developAfter: developBefore,
        rebased: false,
        gate: null,
        cleanedUp: false,
        diagnostics: [],
      };
    }

    // RFC-1538: post-lock revalidation — the registry observed pre-lock can
    // have changed while this run waited on the integration lock (F-0138:
    // a racing integrate's teardown deleted entry+worktree under us).
    const liveRegistry = await readRegistry(io, common);
    const liveEntry = liveRegistry.branches.find((b) => b.name === branch);
    if (liveEntry === undefined) {
      // Registration vanished mid-wait. Contained work already landed → the
      // winner completed; report idempotently. Otherwise mid-teardown.
      const liveBranch = await branchExists(primary, io, branch);
      const liveContained =
        liveBranch &&
        (await isAncestor(
          primary,
          io,
          (await git(primary, io, ["rev-parse", branch])).stdout.trim(),
          "develop",
        ));
      if (liveContained || !liveBranch) {
        return {
          branch,
          integrated: true,
          developBefore,
          developAfter: developBefore,
          rebased: false,
          gate: null,
          cleanedUp: true,
          disposition: "already-integrated",
          diagnostics: [],
        };
      }
      return refuse(
        "FLOW-INT-15",
        `registry entry for ${branch} vanished while waiting on the integration lock, but the branch is not contained in develop (mid-teardown state)`,
        "run flow.status for the live view; recover the orphaned entry with flow.discard",
        { branch, developBefore },
      );
    }

    // (2) the branch worktree must exist and be clean.
    const worktrees = await worktreeList(primary, io);
    // `live` is the worktree git currently associates with the branch — a
    // STALE registration keeps naming the dead recorded path until pruned,
    // so `live !== null` does not prove the directory exists.
    const live = worktrees.find((w) => w.branch === branch)?.path ?? null;
    let branchWorktree = live ?? liveEntry.worktree;
    let reattachedTo: string | undefined;
    // Occupied: the recorded path exists on disk but git associates no live
    // worktree with the branch — a foreign tree squats there.
    const occupied =
      live === null && liveEntry.worktree !== null && (await io.exists(liveEntry.worktree));
    const vanished = !occupied && (branchWorktree === null || !(await io.exists(branchWorktree)));
    if (opts.reattach === true && occupied) {
      return refuse(
        "FLOW-INT-17",
        `registry worktree path ${liveEntry.worktree} exists on disk but is not a worktree of ${branch} (occupied)`,
        "remove or rename the occupant, then re-run flow.integrate --reattach",
        { branch, developBefore },
        { occupied: true },
      );
    }
    if (opts.reattach === true && vanished) {
      // RFC-1531 --reattach: recreate the vanished worktree inside the lock,
      // before the dirty/preflight checks. The recorded registry path is
      // preferred when its parent exists (operators learned that location);
      // the canonical <repo>@<branch> sibling is the fallback.
      const recorded = liveEntry.worktree;
      const target =
        recorded !== null && (await io.exists(dirname(recorded)))
          ? recorded
          : flowWorktreePath(primary, branch);
      // F-0093: a vanished worktree can leave a stale `git worktree`
      // registration that pins the branch — prune before adding (mirrors
      // cleanupIntegrated's ordering).
      await git(primary, io, ["worktree", "prune"]);
      const add = await worktreeAdd(primary, io, target, branch);
      if (add.exitCode !== 0) {
        return refuse(
          "FLOW-INT-17",
          `git worktree add ${target} ${branch} failed: ${add.stderr.trim()}`,
          "resolve the git error (stale registration? occupied path?) and re-run flow.integrate --reattach",
          { branch, developBefore },
        );
      }
      reattachedTo = target;
      branchWorktree = target;
      opts.onProgress?.(`reattached ${branch} at ${target}`);
    }
    if (branchWorktree === null || !(await io.exists(branchWorktree))) {
      return refuse(
        "FLOW-INT-15",
        `registry entry for ${branch} names worktree ${branchWorktree}, which does not exist (vanished mid-teardown state — the branch is not contained in develop)`,
        "re-run with --reattach to recreate the worktree, or run flow.status for the live view and flow.discard to drop the entry",
        { branch, developBefore },
        { vanished: true },
      );
    }
    let dirty = await statusDirty(branchWorktree, io);
    if (dirty.toleratedState.length > 0) {
      opts.onProgress?.(`tolerated forge-local state: ${dirty.toleratedState.join(", ")}`);
    }

    // RFC-1544 AC-2: referent-aware importer-prune resolution — before any
    // remediation, so --autocommit can never sweep a foreign mission's live
    // importer into a commit. `foreign-open-mission` restores the committed
    // importer subtree (never a whole-file checkout — sibling lockfile diffs
    // keep their own classification); `importer-prune-stale` accepts the
    // prune as cleanup and commits it so dead residue stops churning.
    let restoredImporters: string[] | undefined;
    let staleImporterCommitSha: string | undefined;
    if (dirty.entries.some((line) => line.slice(3).trim() === "pnpm-lock.yaml")) {
      const { classifyDirt, resolveImporterReferents } = await import("../preflight.ts");
      const pruneVerdict = await classifyDirt(
        branchWorktree,
        io,
        dirty.entries,
        { runGit: git },
        [],
        (ids) => resolveImporterReferents(branchWorktree, io, ids),
      );
      const lockTolerated = pruneVerdict.tolerated.find((t) => t.path === "pnpm-lock.yaml");
      if (
        lockTolerated?.class === "foreign-open-mission" &&
        lockTolerated.missionIds !== undefined
      ) {
        // ADR-0130: write HEAD verbatim — the diff already classified as
        // importer churn end-to-end (strict prune, or prune + induced
        // `optional: true`/`packages:`/`snapshots:` additions via the
        // extended classifier), so the committed file is the canonical
        // state and a whole-file restore reverts exactly that churn. A
        // block splice would leave the induced additions behind, which
        // is what used to land in the sweep commit.
        const head = await git(branchWorktree, io, ["show", "HEAD:pnpm-lock.yaml"]);
        if (head.exitCode === 0) {
          await io.writeFile(join(branchWorktree, "pnpm-lock.yaml"), head.stdout);
          restoredImporters = lockTolerated.missionIds;
          opts.onProgress?.(
            `restored foreign mission importer(s): ${lockTolerated.missionIds.map((id) => `missions/${id}/workpiece`).join(", ")}`,
          );
          dirty = await statusDirty(branchWorktree, io);
        }
      } else if (lockTolerated?.class === "importer-prune-stale") {
        const add = await git(branchWorktree, io, ["add", "pnpm-lock.yaml"]);
        const commit =
          add.exitCode === 0
            ? await gitCommit(
                branchWorktree,
                io,
                ["commit", "-m", "chore(flow): prune stale mission importer"],
                "integrate",
              )
            : add;
        if (commit.exitCode === 0) {
          staleImporterCommitSha = (
            await git(branchWorktree, io, ["rev-parse", "HEAD"])
          ).stdout.trim();
          opts.onProgress?.(
            `committed stale importer prune ${staleImporterCommitSha.slice(0, 9)} (${(lockTolerated.missionIds ?? []).map((id) => `missions/${id}/workpiece`).join(", ")})`,
          );
          dirty = await statusDirty(branchWorktree, io);
        }
      }
    }

    // RFC-1531 remediation flags — before the dirty checks: --auto-clean
    // deletes ONLY disposable-class paths (closed allowlist — a work-class
    // member in the set deletes nothing and still refuses FLOW-INT-01, and
    // an importer-prune lockfile refuses too: restoring/committing it is a
    // content decision, AC-4), then --autocommit sweeps the remainder into
    // the fixed-subject commit. Remediation failures refuse FLOW-INT-17.
    let autoCleaned: string[] | undefined;
    let autocommitSha: string | undefined;
    if (dirty.entries.length > 0 && (opts.autoClean === true || opts.autocommit === true)) {
      const { classifyDirtyEntries } = await import("../preflight.ts");
      const classified = await classifyDirtyEntries(branchWorktree, io, dirty.entries);
      // Pass = AUTO_CLEAN_PASS_CLASSES (tolerated family incl. the RFC-1537
      // regenerable classes) or disposable. Blocker = work or importer-prune
      // — AC-4 names importer-prune a refusal class: restoring/committing a
      // lockfile is a content decision, never a cleanup step.
      const blocker = classified.filter(
        (c) => c.class !== "disposable" && !AUTO_CLEAN_PASS_CLASSES.includes(c.class),
      );
      if (opts.autoClean === true) {
        // A blocker refuses only when nothing downstream will commit it:
        // with --autocommit also set, work members sweep into the commit —
        // the RFC's composed order is clean → commit → integrate.
        if (blocker.length > 0 && opts.autocommit !== true) {
          return refuse(
            "FLOW-INT-01",
            `worktree ${branchWorktree} has ${blocker.length} uncommitted change(s) outside the disposable set: ${blocker
              .slice(0, 10)
              .map((b) => `${b.path} (${b.class})`)
              .join(", ")} — --auto-clean deletes nothing on a mixed set`,
            "commit or revert the work-class entries inside the session worktree, or re-run with --autocommit to sweep them into a commit",
            { branch, developBefore, toleratedState: dirty.toleratedState },
            {
              entries: classified,
              classes: summarizeClasses(classified),
              toleratedState: dirty.toleratedState,
            },
          );
        }
        const toDelete = classified.filter((c) => c.class === "disposable");
        autoCleaned = [];
        for (const entry of toDelete) {
          try {
            await rm(join(branchWorktree, entry.path), { force: true, recursive: true });
            autoCleaned.push(entry.path);
            opts.onProgress?.(`auto-clean: deleted ${entry.path}`);
          } catch (error) {
            return refuse(
              "FLOW-INT-17",
              `--auto-clean could not delete ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
              "delete the path manually inside the session worktree, then re-run flow.integrate",
              { branch, developBefore, autoCleaned },
            );
          }
        }
        dirty = await statusDirty(branchWorktree, io);
      }
      if (opts.autocommit === true && dirty.entries.length > 0) {
        // Stage exactly the remaining entry paths — never `git add -A`:
        // tolerated FORGE_STATE paths are journaled, never committed.
        const paths = dirty.entries.map((line) => line.slice(3).trim());
        const add = await git(branchWorktree, io, ["add", "-A", "--", ...paths]);
        if (add.exitCode !== 0) {
          return refuse(
            "FLOW-INT-17",
            `--autocommit staging failed: ${add.stderr.trim()}`,
            "inspect the session worktree state, then re-run flow.integrate",
            { branch, developBefore, autoCleaned },
          );
        }
        const commit = await gitCommit(
          branchWorktree,
          io,
          ["commit", "-m", SWEEP_COMMIT_SUBJECT],
          "integrate",
        );
        if (commit.exitCode !== 0) {
          return refuse(
            "FLOW-INT-17",
            `--autocommit commit failed: ${commit.stderr.trim()}`,
            "the staging stays for the operator to inspect — resolve and commit or reset inside the session worktree, then re-run",
            { branch, developBefore, autoCleaned },
          );
        }
        autocommitSha = (await git(branchWorktree, io, ["rev-parse", "HEAD"])).stdout.trim();
        opts.onProgress?.(
          `autocommit: swept ${paths.length} path(s) into ${autocommitSha.slice(0, 9)} (${SWEEP_COMMIT_SUBJECT})`,
        );
        dirty = await statusDirty(branchWorktree, io);
      }
    }
    // RFC-1537: declared regenerable dirt tolerated on this attempt —
    // surfaced in data + journaled on integrate/refusal, never committed.
    let toleratedDirt: Array<{ path: string; class: string }> = [];
    // RFC-1599: primary dirt rows with live-session attribution — warning
    // surfaced in the diagnostics collector below, never a refusal.
    let foreignDirt: Array<{ path: string; owningSession: string | null }> = [];
    // RFC-1528: bounded preflight — dirty-tree checks with lockfile
    // classification, then the four validators that used to fire only inside
    // the expensive integration gate. Non-port path only (port entries keep
    // their own FLOW-INT-09/10 semantics); first failure refuses before the
    // rebase and before the gate spawns.
    if (entry.port === null) {
      const { runIntegratePreflight } = await import("../preflight.ts");
      const preflight = await runIntegratePreflight({
        primary,
        branchWorktree,
        branch,
        io,
        worktreeDirty: dirty,
        invoke: opts.invoke,
        commandRegistry: opts.commandRegistry,
        waitForeignSeconds: opts.waitForeignSeconds,
        onProgress: opts.onProgress,
      });
      toleratedDirt = preflight.tolerated;
      foreignDirt = preflight.foreignDirt ?? [];
      for (const skipped of preflight.skipped) {
        opts.onProgress?.(
          skipped.reason === "no-invoke"
            ? `preflight: ${skipped.check} skipped — no invoke port (standalone CLI)`
            : `preflight: ${skipped.check} skipped — command not in the live inventory`,
        );
      }
      for (const t of preflight.tolerated) {
        opts.onProgress?.(`tolerated regenerable state: ${t.path} (${t.class})`);
      }
      if (!preflight.ok && preflight.refuse) {
        const refusal = refuse(
          preflight.refuse.ruleId,
          preflight.refuse.message,
          preflight.refuse.fixHint,
          {
            branch,
            developBefore,
            toleratedState: dirty.toleratedState,
            toleratedDirt: preflight.tolerated,
            reattachedTo,
            autoCleaned,
            autocommitSha,
            restoredImporters,
            staleImporterCommitSha,
          },
          preflight.refuse.data,
        );
        // RFC-1599: the same foreignDirt rows that warn on the pass path ride
        // a FLOW-INT-03 refusal as a warning diagnostic — attribution is
        // audit, never the refusal's cause.
        const refusalRows = preflight.refuse.data?.foreignDirt as
          Array<{ path: string; owningSession: string | null }> | undefined;
        if (refusalRows !== undefined && refusalRows.length > 0) {
          refusal.diagnostics.push(foreignDirtWarning(refusalRows));
        }
        return refusal;
      }
    } else if (dirty.entries.length > 0) {
      // Port path keeps its own refusal surface but the same regenerable
      // classes still tolerate (RFC-1537) — an importer-materializing port
      // worktree is no harder to integrate than a session one.
      const { classifyDirt } = await import("../preflight.ts");
      const verdict = await classifyDirt(branchWorktree, io, dirty.entries);
      toleratedDirt = verdict.tolerated;
      for (const t of verdict.tolerated) {
        opts.onProgress?.(`tolerated regenerable state: ${t.path} (${t.class})`);
      }
      if (verdict.unattributed.length > 0) {
        const entries = verdict.unattributed.map((line) => {
          const path = line.slice(3).trim();
          return { path, class: classifyDirtyPath(path) };
        });
        return refuse(
          "FLOW-INT-01",
          `worktree ${branchWorktree} has ${verdict.unattributed.length} uncommitted change(s): ${verdict.unattributed.slice(0, 10).join(", ")}` +
            (verdict.tolerated.length > 0
              ? ` — tolerated regenerable state: ${verdict.tolerated.map((t) => `${t.path} (${t.class})`).join(", ")}`
              : "") +
            (dirty.toleratedState.length > 0
              ? ` — tolerated forge-local state: ${dirty.toleratedState.join(", ")}`
              : ""),
          "commit or revert the uncommitted changes inside the session worktree, or remediate with --auto-clean / --autocommit, then re-run",
          {
            branch,
            developBefore,
            toleratedState: dirty.toleratedState,
            toleratedDirt: verdict.tolerated,
            reattachedTo,
            autoCleaned,
            autocommitSha,
            restoredImporters,
            staleImporterCommitSha,
          },
          {
            entries,
            classes: summarizeClasses(entries),
            toleratedState: dirty.toleratedState,
          },
        );
      }
    }

    // Port entries (RFC-1490): develop must not have moved since the port
    // opened, and the tip must be the fixed-message merge whose second
    // parent is port.mainSha. No rebase — that would linearize the merge.
    if (entry.port !== null) {
      if (developBefore !== entry.baseSha) {
        return refuse(
          "FLOW-INT-10",
          `develop moved to ${developBefore.slice(0, 9)} since the port branch opened (base ${entry.baseSha.slice(0, 9)})`,
          "run flow.backmerge --redo to reopen the port on the new develop tip",
          { branch, developBefore },
        );
      }
      const expectedSubject = `release ${entry.port.tags.join(", ")} → develop`;
      const parents = await git(branchWorktree, io, ["rev-list", "--parents", "-1", "HEAD"]);
      const parts = parents.stdout.trim().split(/\s+/);
      const subject = (await git(branchWorktree, io, ["log", "-1", "--format=%s"])).stdout.trim();
      if (parts.length !== 3 || parts[2] !== entry.port.mainSha || subject !== expectedSubject) {
        return refuse(
          "FLOW-INT-09",
          `port tip is not the back-merge commit — expected merge '${expectedSubject}' with second parent ${entry.port.mainSha.slice(0, 9)}`,
          "commit the resolved merge inside the port worktree with git commit --no-edit, or run flow.backmerge --redo",
          { branch, developBefore },
        );
      }
    }

    // (2d) RFC-1600 AC-3: duplicate-governance-id preflight — the branch's
    // new artifacts must not collide with ids develop already carries
    // (file families + rule literals). Refusal only, never auto-renumber;
    // port entries keep their merge shape and skip the scan.
    if (entry.port === null) {
      const { scanDuplicateGovernanceIds } = await import("../dup-id-scan.ts");
      const dups = await scanDuplicateGovernanceIds(primary, io, "develop", branch);
      const duplicates = [...dups.fileIds, ...dups.ruleIds];
      if (duplicates.length > 0) {
        return refuse(
          "FLOW-INT-19",
          `duplicate governance id(s) on ${branch}: ${duplicates
            .map((d) => `${d.id} (branch: ${d.onBranch}; develop: ${d.onDevelop})`)
            .join("; ")}`,
          "renumber the branch artifacts via the family's next-id, regenerate the index surfaces, then re-run flow.integrate — allocation races are prevented by forge/rfc-reservations.yaml",
          { branch, developBefore },
          { duplicates },
        );
      }
    }

    // (3) rebase onto the current develop — never for port entries.
    // RFC-1538: a conflict confined to generated artifacts resolves via its
    // owner command (checkout --theirs + regenerate + continue) — the
    // generated-file doctrine applied inside the rebase path; anything else
    // still refuses FLOW-INT-02 for a human.
    const rebaseBase = (await git(primary, io, ["rev-parse", "develop"])).stdout.trim();
    let autoResolved: string[] = [];
    let autoResolveDeferred: string[] = [];
    if (entry.port === null) {
      const rebased = await rebaseOnto(branchWorktree, "develop", { branch, developBefore });
      if ("diagnostics" in rebased) return rebased;
      autoResolved = rebased.autoResolved;
      autoResolveDeferred = rebased.autoResolveDeferred;
    }

    // (3b) RFC-1574: post-rebase regeneration — derived manifests depend on
    // develop + branch, so they are regenerated on the rebased tree and the
    // change is committed before the gate judges it (F-0168).
    let postRebaseRegen: PostRebaseRegenResult | undefined;
    if (entry.port === null) {
      const regen = await regenManifests(branchWorktree, {
        branch,
        developBefore,
        rebased: true,
      });
      if (regen !== null && "diagnostics" in regen) return regen;
      postRebaseRegen = regen ?? undefined;
    }

    // (4) integration gate — the primary's script, executed by the session
    // engine's build when the worktree carries one (RFC-1538): the code
    // under review judges itself; the checks it faces stay primary-owned.
    const { resolveGateEngine } = await import("../gate-engine.ts");
    const engine = await resolveGateEngine(branchWorktree, primary, io);
    const warnings: Diagnostic[] = [];
    if (foreignDirt.length > 0) {
      warnings.push(foreignDirtWarning(foreignDirt));
    }
    if (
      engine.source === "primary" &&
      (await io.exists(join(primary, "hooks", "integration-gate.sh")))
    ) {
      warnings.push({
        ruleId: "FLOW-INT-16",
        severity: "warning",
        message: `no session engine build under ${branchWorktree} — the integration gate runs the primary engine`,
        fixHint:
          "run pnpm install inside the session worktree to have its own build judged; the F-0137 self-referential escape is a backport worktree",
      });
    }
    opts.onProgress?.(`gate engine: ${engine.source} (${engine.root})`);
    const gate = await runFlowScript(io, "integration-gate", {
      primary,
      cwd: engine.root,
      env: {
        FLOW_PRIMARY: primary,
        FLOW_BRANCH: branch,
        FLOW_BASE_SHA: rebaseBase,
        FORGE_FLOW_TARGET: opts.target ?? "develop",
        ...(gateModeEnv !== undefined ? { FORGE_GATE_MODE: gateModeEnv } : {}),
      },
    });
    if (gate.status === "failed") {
      return refuse(
        "FLOW-INT-05",
        `hooks/integration-gate.sh refused the integration (exit ${gate.exitCode}): ${gate.stderrTail}`,
        `fix what ${primary}/hooks/integration-gate.sh demands, then re-run`,
        { branch, developBefore, rebased: entry.port === null, gate },
        // RFC-1532 AC-4: name the persisted report so the fixing agent reads
        // full check rows instead of re-running the gate.
        gate.reportPath ? { reportPath: gate.reportPath } : undefined,
      );
    }

    // (4b) RFC-1580: correctness gate from the PRIMARY install, judging the
    // session worktree against the develop tip it integrates into.
    const { runCorrectnessStep } = await import("../correctness-step.ts");
    const correctness = await runCorrectnessStep(io, {
      primary,
      worktree: branchWorktree,
      base: rebaseBase,
      ...(opts.acceptWeakening ? { acceptWeakening: opts.acceptWeakening } : {}),
    });
    if (correctness.refusal) {
      return refuse(
        "FLOW-INT-18",
        correctness.refusal.message,
        correctness.refusal.fixHint,
        { branch, developBefore, rebased: entry.port === null, gate },
        correctness.bundlePath ? { bundlePath: correctness.bundlePath } : undefined,
      );
    }
    if (correctness.warning) warnings.push(correctness.warning);
    opts.onProgress?.(
      `correctness gate: ${correctness.status}${correctness.bundlePath ? ` (${correctness.bundlePath})` : ""}`,
    );

    const state: IntegrateGateState = {
      branch,
      entry,
      branchWorktree,
      developBefore,
      rebaseBase,
      branchTip: (await git(primary, io, ["rev-parse", branch])).stdout.trim(),
      dirtyToleratedState: dirty.toleratedState,
      toleratedDirt,
      autoResolved,
      ...(autoResolveDeferred.length > 0 ? { autoResolveDeferred } : {}),
      ...(postRebaseRegen !== undefined ? { postRebaseRegen } : {}),
      ...(reattachedTo !== undefined ? { reattachedTo } : {}),
      ...(autoCleaned !== undefined ? { autoCleaned } : {}),
      ...(autocommitSha !== undefined ? { autocommitSha } : {}),
      ...(restoredImporters !== undefined ? { restoredImporters } : {}),
      ...(staleImporterCommitSha !== undefined ? { staleImporterCommitSha } : {}),
      gate,
      engine,
      warnings,
      correctness: {
        status: correctness.status,
        bundlePath: correctness.bundlePath,
        acceptedWeakening: correctness.acceptedWeakening,
      },
    };
    return { kind: "ready", state };
  };

  // (5) primary must sit clean on develop, then fast-forward — the locked
  // tail shared by the legacy sequence and the pre-lock Phase B.
  const integrateMergeTail = async (
    s: IntegrateGateState,
    extras?: {
      gateMode?: IntegrateGateMode;
      lockHeldMs?: number;
      preLockAttempts?: number;
      deltaSelection?: DeltaGateSelection;
    },
  ): Promise<FlowIntegrateData> => {
    const {
      branch,
      entry,
      branchWorktree,
      developBefore,
      gate,
      engine,
      warnings,
      autoResolved,
      autoResolveDeferred,
      postRebaseRegen,
      reattachedTo,
      autoCleaned,
      autocommitSha,
      restoredImporters,
      staleImporterCommitSha,
      correctness,
    } = s;
    let toleratedDirt = [...s.toleratedDirt];
    // (5) primary must sit clean on develop, then fast-forward. Mid-gate
    // importer churn from another session's open mission tolerates here too
    // (RFC-1537) — the same classifier the preflight ran.
    const primaryBranch = await currentBranch(primary, io);
    const primaryDirty = await statusTracked(primary, io);
    if (primaryBranch !== "develop" || primaryDirty.entries.length > 0) {
      let unattributed = primaryDirty.entries;
      if (primaryDirty.entries.length > 0) {
        const { classifyDirt } = await import("../preflight.ts");
        const verdict = await classifyDirt(primary, io, primaryDirty.entries);
        unattributed = verdict.unattributed;
        if (verdict.tolerated.length > 0) {
          toleratedDirt = [...toleratedDirt, ...verdict.tolerated];
          for (const t of verdict.tolerated) {
            opts.onProgress?.(`tolerated regenerable state on primary: ${t.path} (${t.class})`);
          }
        }
      }
      if (primaryBranch !== "develop" || unattributed.length > 0) {
        return refuse(
          "FLOW-INT-03",
          primaryBranch !== "develop"
            ? `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`
            : `primary worktree has ${unattributed.length} uncommitted change(s)`,
          "switch the primary to develop and commit or revert its tracked changes, then re-run — the branch stays rebased",
          {
            branch,
            developBefore,
            rebased: entry.port === null,
            gate,
            ...(toleratedDirt.length > 0 ? { toleratedDirt } : {}),
          },
        );
      }
    }
    const developNow = (await git(primary, io, ["rev-parse", "develop"])).stdout.trim();
    if (!(await isAncestor(primary, io, developNow, branch))) {
      return refuse(
        "FLOW-INT-07",
        `develop moved to ${developNow.slice(0, 9)} after the rebase despite the integration lock`,
        "re-run flow.integrate — it rebases onto the new develop tip",
        { branch, developBefore, rebased: entry.port === null, gate },
      );
    }
    if (correctness.acceptedWeakening) {
      // RFC-1580: the accepted weakening is recorded on the integration itself.
      const { CORRECTNESS_WEAKENING_TRAILER } = await import("../correctness-step.ts");
      const trailer = await git(branchWorktree, io, [
        "commit",
        "--allow-empty",
        "-m",
        `flow: accept correctness weakening\n\n${CORRECTNESS_WEAKENING_TRAILER}: ${correctness.acceptedWeakening.replace(/\s+/g, " ").trim()}`,
      ]);
      if (trailer.exitCode !== 0) {
        return refuse(
          "FLOW-INT-18",
          `could not record ${CORRECTNESS_WEAKENING_TRAILER} on the branch: ${trailer.stderr.trim()}`,
          "commit the trailer by hand in the session worktree, then re-run",
          { branch, developBefore, rebased: entry.port === null, gate },
        );
      }
    }
    const merge = await git(primary, io, ["merge", "--ff-only", branch]);
    if (merge.exitCode !== 0) {
      return refuse(
        "FLOW-INT-07",
        `git merge --ff-only ${branch} failed: ${merge.stderr.trim()}`,
        "develop diverged from the rebased base — re-run flow.integrate to rebase again",
        { branch, developBefore, rebased: entry.port === null, gate },
      );
    }
    const developAfter = (await git(primary, io, ["rev-parse", "develop"])).stdout.trim();
    return {
      branch,
      integrated: true,
      developBefore,
      developAfter,
      rebased: entry.port === null,
      gate,
      cleanedUp: false,
      ...(s.dirtyToleratedState.length > 0 ? { toleratedState: s.dirtyToleratedState } : {}),
      ...(toleratedDirt.length > 0 ? { toleratedDirt } : {}),
      ...(autoResolved.length > 0 ? { autoResolved } : {}),
      ...(autoResolveDeferred !== undefined && autoResolveDeferred.length > 0
        ? { autoResolveDeferred }
        : {}),
      ...(postRebaseRegen !== undefined ? { postRebaseRegen } : {}),
      ...(reattachedTo !== undefined ? { reattachedTo } : {}),
      ...(autoCleaned !== undefined && autoCleaned.length > 0 ? { autoCleaned } : {}),
      ...(autocommitSha !== undefined ? { autocommitSha } : {}),
      ...(restoredImporters !== undefined && restoredImporters.length > 0
        ? { restoredImporters }
        : {}),
      ...(staleImporterCommitSha !== undefined ? { staleImporterCommitSha } : {}),
      gateEngine: engine.source,
      correctnessGate: {
        status: correctness.status,
        bundlePath: correctness.bundlePath,
        acceptedWeakening: correctness.acceptedWeakening,
      },
      ...(extras?.gateMode !== undefined ? { gateMode: extras.gateMode } : {}),
      ...(extras?.lockHeldMs !== undefined ? { lockHeldMs: extras.lockHeldMs } : {}),
      ...(extras?.preLockAttempts !== undefined ? { preLockAttempts: extras.preLockAttempts } : {}),
      ...(extras?.deltaSelection !== undefined ? { deltaSelection: extras.deltaSelection } : {}),
      diagnostics: warnings,
    };
  };

  const integrateInner = async (): Promise<FlowIntegrateData> => {
    const phase = await integrateGatePhase();
    if (!("state" in phase)) return phase;
    return integrateMergeTail(phase.state);
  };

  /** RFC-1589 Phase B — inside integrate.lock: revalidate the Phase-A
   * verdict's coverage, read B1, and either fast-forward on the still-fresh
   * verdict (pre-lock), run the develop-delta selection under the lock
   * (locked-delta), or run the complete gate (locked-full) once the attempt
   * budget is spent. A "restart" result releases the lock and discards the
   * attempt — the caller re-runs Phase A against the moved develop. */
  const integrateLockedPhase = async (
    s: IntegrateGateState,
    attempt: number,
  ): Promise<LockedPhaseResult> => {
    const lockStart = Date.now();
    const out = (
      mode: IntegrateGateMode,
      data: FlowIntegrateData,
      deltaSelection?: DeltaGateSelection,
    ): LockedPhaseResult => ({
      kind: "result",
      mode,
      data,
      lockHeldMs: Date.now() - lockStart,
      ...(deltaSelection !== undefined ? { deltaSelection } : {}),
    });

    // RFC-1538 revalidation — the registry/worktree observed before the
    // lock wait can have moved while Phase A ran unlocked.
    const liveRegistry = await readRegistry(io, common);
    const liveEntry = liveRegistry.branches.find((b) => b.name === branch);
    if (liveEntry === undefined) {
      const liveBranch = await branchExists(primary, io, branch);
      const liveContained =
        liveBranch &&
        (await isAncestor(
          primary,
          io,
          (await git(primary, io, ["rev-parse", branch])).stdout.trim(),
          "develop",
        ));
      if (liveContained || !liveBranch) {
        return out("pre-lock", {
          branch,
          integrated: true,
          developBefore: s.developBefore,
          developAfter: s.developBefore,
          rebased: false,
          gate: null,
          cleanedUp: true,
          disposition: "already-integrated",
          diagnostics: [],
        });
      }
      return out(
        "pre-lock",
        refuse(
          "FLOW-INT-15",
          `registry entry for ${branch} vanished while waiting on the integration lock, but the branch is not contained in develop (mid-teardown state)`,
          "run flow.status for the live view; recover the orphaned entry with flow.discard",
          { branch, developBefore: s.developBefore },
        ),
      );
    }
    if (!(await io.exists(s.branchWorktree))) {
      return out(
        "pre-lock",
        refuse(
          "FLOW-INT-15",
          `registry entry for ${branch} names worktree ${s.branchWorktree}, which does not exist (vanished mid-wait state — the branch is not contained in develop)`,
          "re-run with --reattach to recreate the worktree, or run flow.status for the live view and flow.discard to drop the entry",
          { branch, developBefore: s.developBefore },
          { vanished: true },
        ),
      );
    }

    // The recorded verdict binds an exact branch tip and a clean worktree —
    // new commits or fresh dirt mean Phase A's gate no longer covers the
    // tree; the attempt is discarded (or, on the last attempt, the full
    // gate re-runs under the lock to cover the moved state honestly).
    const tipNow = (await git(primary, io, ["rev-parse", branch])).stdout.trim();
    const dirtyNow = await statusDirty(s.branchWorktree, io);
    const tipMoved = tipNow !== s.branchTip;
    const dirtArrived = dirtyNow.entries.length > 0;
    if ((tipMoved || dirtArrived) && attempt < MAX_PRELOCK_ATTEMPTS) {
      opts.onProgress?.(
        `pre-lock attempt ${attempt}: ${tipMoved ? "branch tip" : "worktree"} moved during the lock wait — discarding and restarting Phase A`,
      );
      return { kind: "restart" };
    }
    if (dirtArrived) {
      return out(
        "pre-lock",
        refuse(
          "FLOW-INT-01",
          `worktree ${s.branchWorktree} has ${dirtyNow.entries.length} uncommitted change(s) that arrived during the lock wait`,
          "commit or revert the uncommitted changes inside the session worktree, then re-run",
          { branch, developBefore: s.developBefore },
        ),
      );
    }

    const b1 = (await git(primary, io, ["rev-parse", "develop"])).stdout.trim();
    let mode: IntegrateGateMode;
    let deltaSelection: DeltaGateSelection | undefined;
    if (b1 === s.rebaseBase && !tipMoved) {
      mode = "pre-lock";
      opts.onProgress?.(
        `pre-lock verdict still fresh (develop unmoved at ${b1.slice(0, 9)}) — no under-lock gate`,
      );
    } else {
      if (b1 !== s.rebaseBase) {
        // Develop moved between the Phase-A verdict and the lock — rebase
        // and regenerate onto B1 before the delta selection runs.
        const rebased = await rebaseOnto(s.branchWorktree, b1, {
          branch,
          developBefore: s.developBefore,
        });
        if ("diagnostics" in rebased) return out("locked-delta", rebased);
        s.autoResolved.push(...rebased.autoResolved);
        if (rebased.autoResolveDeferred.length > 0) {
          (s.autoResolveDeferred ??= []).push(...rebased.autoResolveDeferred);
        }
        const regen = await regenManifests(s.branchWorktree, {
          branch,
          developBefore: s.developBefore,
          rebased: true,
        });
        if (regen !== null && "diagnostics" in regen) return out("locked-delta", regen);
        if (regen !== null) s.postRebaseRegen = regen;
      }
      if (attempt >= MAX_PRELOCK_ATTEMPTS) {
        mode = "locked-full";
      } else {
        const delta =
          b1 !== s.rebaseBase ? await deltaChangedPaths(io, primary, s.rebaseBase, b1) : [];
        deltaSelection =
          opts.deltaGateSelector !== undefined
            ? await opts.deltaGateSelector(delta)
            : selectDeltaGateSteps(delta, await resolveDeltaStepDomains(io, primary));
        if (deltaSelection.selected.length * 2 > deltaSelection.total) {
          opts.onProgress?.(
            `pre-lock attempt ${attempt}: develop delta selects ${deltaSelection.selected.length}/${deltaSelection.total} gate steps — discarding and restarting Phase A against ${b1.slice(0, 9)}`,
          );
          return { kind: "restart" };
        }
        mode = "locked-delta";
      }
      // Under the lock the gate runs with FLOW_BASE_SHA = the recorded B0:
      // on the judged worktree the gate's own RFC-1582 selection runs over
      // ours ∪ delta — a superset of the delta selection + always rows,
      // never under-selected, always judged on the tree that will land.
      const gate = await runFlowScript(io, "integration-gate", {
        primary,
        cwd: s.engine.root,
        env: {
          FLOW_PRIMARY: primary,
          FLOW_BRANCH: branch,
          FLOW_BASE_SHA: s.rebaseBase,
          FORGE_FLOW_TARGET: opts.target ?? "develop",
          FORGE_GATE_MODE: mode,
          ...(mode === "locked-full" ? { FLOW_GATE_FULL: "1" } : {}),
        },
      });
      if (gate.status === "failed") {
        return out(
          mode,
          refuse(
            "FLOW-INT-05",
            `hooks/integration-gate.sh refused the ${mode} integration gate (exit ${gate.exitCode}): ${gate.stderrTail}`,
            `fix what ${primary}/hooks/integration-gate.sh demands, then re-run`,
            { branch, developBefore: s.developBefore, rebased: true, gate },
            gate.reportPath ? { reportPath: gate.reportPath } : undefined,
          ),
        );
      }
      s.gate = gate;
      const { runCorrectnessStep } = await import("../correctness-step.ts");
      const correctness = await runCorrectnessStep(io, {
        primary,
        worktree: s.branchWorktree,
        base: b1,
        ...(opts.acceptWeakening ? { acceptWeakening: opts.acceptWeakening } : {}),
      });
      if (correctness.refusal) {
        return out(
          mode,
          refuse(
            "FLOW-INT-18",
            correctness.refusal.message,
            correctness.refusal.fixHint,
            { branch, developBefore: s.developBefore, rebased: true, gate },
            correctness.bundlePath ? { bundlePath: correctness.bundlePath } : undefined,
          ),
        );
      }
      if (correctness.warning) s.warnings.push(correctness.warning);
      opts.onProgress?.(
        `correctness gate (${mode}): ${correctness.status}${correctness.bundlePath ? ` (${correctness.bundlePath})` : ""}`,
      );
      s.correctness = {
        status: correctness.status,
        bundlePath: correctness.bundlePath,
        acceptedWeakening: correctness.acceptedWeakening,
      };
      s.branchTip = (await git(primary, io, ["rev-parse", branch])).stdout.trim();
    }
    const data = await integrateMergeTail(s);
    return out(mode, data, deltaSelection);
  };

  /** RFC-1589 Phase A→B attempts: the gate phase runs unlocked and records
   * a `pre-lock` verdict; the locked phase either lands it or discards the
   * attempt (bounded — the last attempt runs locked-full). */
  const integratePreLock = async (): Promise<FlowIntegrateData> => {
    for (let attempt = 1; attempt <= MAX_PRELOCK_ATTEMPTS; attempt++) {
      const phase = await integrateGatePhase("pre-lock");
      if (!("state" in phase)) return phase;
      const s = phase.state;
      await recordPreLockVerdict(io, common, {
        branch,
        branchTip: s.branchTip,
        base: s.rebaseBase,
        steps: await gateReportSteps(io, primary, s.gate.reportPath),
        ...(s.gate.reportPath ? { reportPath: s.gate.reportPath } : {}),
      });
      const locked = await withFlowLock(
        lockPath,
        lockOpts,
        () => integrateLockedPhase(s, attempt),
        io,
      );
      if (locked.kind === "restart") continue;
      return {
        ...locked.data,
        gateMode: locked.mode,
        lockHeldMs: locked.lockHeldMs,
        preLockAttempts: attempt,
        ...(locked.deltaSelection !== undefined ? { deltaSelection: locked.deltaSelection } : {}),
      };
    }
    // Unreachable — the last attempt never returns "restart".
    throw new Error("pre-lock integrate exhausted attempts without a result");
  };

  const lockOpts = {
    waitMs: opts.lockWaitMs ?? INTEGRATE_LOCK_WAIT_MS,
    staleMs: INTEGRATE_LOCK_STALE_MS,
    progressEveryMs: 60_000,
    onProgress: opts.onProgress,
    onStale: (l: { reason: string; pid?: number; host?: string; at: string; ageMs: number }) =>
      opts.onProgress?.(
        l.reason === "dead-holder"
          ? `broke dead-holder integration lock (pid ${l.pid ?? "?"} on ${l.host ?? "?"}, held since ${l.at})`
          : `broke stale integration lock (held since ${l.at}, ${Math.round(l.ageMs / 60000)} min old)`,
      ),
  };

  let inner: FlowIntegrateData;
  try {
    const usePreLock = opts.preLock === true && entry.port === null && opts.lockHeld !== true;
    inner = usePreLock
      ? await integratePreLock()
      : opts.lockHeld === true
        ? await integrateInner()
        : await withFlowLock(lockPath, lockOpts, integrateInner, io);
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      // RFC-1515 AC-4: a refused attempt reports the holder on the first
      // try — the lock payload names pid/host/at/heldMs plus a disposition
      // computed by the same dead-holder classifier withFlowLock uses.
      const holder = error.holder;
      const lock: LockDiagnostic | undefined =
        holder === undefined ? undefined : describeHeldLock(holder, INTEGRATE_LOCK_STALE_MS);
      return refuse(
        "FLOW-INT-08",
        lock === undefined
          ? `integration lock ${error.lockPath} is held by another integration (holder unknown)`
          : `integration lock ${error.lockPath} is held by pid ${lock.pid} on ${lock.host ?? "unknown host"} since ${lock.at} (${lock.disposition})`,
        "run forge werkstatt.lock.status for the live view, or forge werkstatt.lock.recover to break a dead holder's lock",
        { branch, lock },
      );
    }
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`, {
        branch,
      });
    }
    throw error;
  }

  // Only error-severity diagnostics are refusals — warnings (e.g. the
  // FLOW-INT-16 primary-engine notice) must not skip cleanup and journaling.
  if (!inner.integrated || inner.diagnostics.some((d) => d.severity === "error")) return inner;

  // (6) cleanup — outside the lock; every git call runs with -C primary.
  // RFC-1536: prune this session's own id reservations once the branch
  // landed — other sessions' entries stay untouched.
  await pruneReservationsForSession(io, primary, branch);

  const worktrees = await worktreeList(primary, io);
  const branchWorktree = worktrees.find((w) => w.branch === branch)?.path ?? entry.worktree;
  const cleanup = await cleanupIntegrated(
    primary,
    branchWorktree,
    entry,
    common,
    inner.developAfter ?? inner.developBefore ?? "",
    io,
    now.toISOString(),
    entry.port !== null ? "backmerge" : "integrate",
    inner.developBefore ?? undefined,
    inner.toleratedDirt,
    inner.autoResolved,
    {
      reattachedTo: inner.reattachedTo,
      autoCleaned: inner.autoCleaned,
      autocommitSha: inner.autocommitSha,
      restoredImporters: inner.restoredImporters,
      staleImporterCommitSha: inner.staleImporterCommitSha,
    },
    inner.gate?.reportPath ?? undefined,
    inner.gateMode !== undefined &&
      inner.lockHeldMs !== undefined &&
      inner.preLockAttempts !== undefined
      ? {
          gateMode: inner.gateMode,
          lockHeldMs: inner.lockHeldMs,
          preLockAttempts: inner.preLockAttempts,
        }
      : undefined,
  );
  return {
    ...inner,
    gate: inner.gate,
    teardown: cleanup.gate,
    cleanedUp: cleanup.cleanedUp,
    // Integration warnings (FLOW-INT-16, FLOW-INT-18) survive the cleanup report.
    diagnostics: [
      ...inner.diagnostics.filter((d) => d.severity !== "error"),
      ...cleanup.diagnostics,
    ],
  };
}

export async function runFlowIntegrate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowIntegrateData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.integrate must run inside a git repository");
  }

  const branchFlag = input.flags["branch"];
  const data = await integrateFlowBranch(repoRoot, io, {
    branch: typeof branchFlag === "string" ? branchFlag : null,
    dryRun: context.dryRun || input.flags["dry-run"] === true,
    onProgress: (m) => logger.info(`  ${m}`),
    invoke: context.invoke,
    commandRegistry: context.commandRegistry,
    reattach: input.flags["reattach"] === true,
    autoClean: input.flags["auto-clean"] === true,
    autocommit: input.flags["autocommit"] === true,
    ...(typeof input.flags["accept-weakening"] === "string" &&
    input.flags["accept-weakening"].trim()
      ? { acceptWeakening: input.flags["accept-weakening"] }
      : {}),
    waitForeignSeconds:
      typeof input.flags["wait-foreign"] === "string" ||
      typeof input.flags["wait-foreign"] === "number"
        ? Number(input.flags["wait-foreign"])
        : undefined,
    // RFC-1589: FORGE_INTEGRATE_PRELOCK=1 moves the gate outside the lock;
    // --gate-under-lock is the operator escape hatch back to the old
    // sequence while the comparison runs.
    preLock:
      input.flags["gate-under-lock"] === true ? false : process.env.FORGE_INTEGRATE_PRELOCK === "1",
  });

  const refused = data.diagnostics.find((d) => d.severity === "error");
  if (outputFormat === "pretty") {
    if (refused) {
      logger.error(`flow.integrate refused: ${refused.message}`);
    } else {
      logger.section("flow.integrate");
      logger.info(`  branch:    ${data.branch}`);
      logger.info(`  integrated: ${data.integrated}${data.rebased ? " (rebased)" : ""}`);
      logger.info(
        `  develop:   ${data.developBefore?.slice(0, 9)} → ${data.developAfter?.slice(0, 9)}`,
      );
      logger.info(`  cleanedUp: ${data.cleanedUp}`);
      if (data.gateMode !== undefined) {
        logger.info(
          `  gate mode:  ${data.gateMode}${data.lockHeldMs !== undefined ? ` (lock held ${Math.round(data.lockHeldMs / 1000)}s, attempt ${data.preLockAttempts ?? 1})` : ""}`,
        );
      }
      if (data.toleratedDirt !== undefined && data.toleratedDirt.length > 0) {
        logger.info(
          `  tolerated: ${data.toleratedDirt.map((t) => `${t.path} (${t.class})`).join(", ")}`,
        );
      }
      if (data.toleratedState !== undefined && data.toleratedState.length > 0) {
        logger.info(`  tolerated forge state: ${data.toleratedState.join(", ")}`);
      }
      if (data.reattachedTo !== undefined) {
        logger.info(`  reattached: ${data.reattachedTo}`);
      }
      if (data.autoCleaned !== undefined && data.autoCleaned.length > 0) {
        logger.info(`  auto-cleaned: ${data.autoCleaned.join(", ")}`);
      }
      if (data.autocommitSha !== undefined) {
        logger.info(`  autocommit: ${data.autocommitSha.slice(0, 9)} (${SWEEP_COMMIT_SUBJECT})`);
      }
    }
  }

  return {
    data,
    exitCode: refused ? 1 : 0,
    summary: refused
      ? `[flow.integrate] refused: ${refused.ruleId} ${refused.message}`
      : `[flow.integrate] ${data.branch} integrated (${data.developBefore?.slice(0, 9)} → ${data.developAfter?.slice(0, 9)}), cleanup ${data.cleanedUp ? "done" : "pending"}`,
    nextSteps: refused
      ? []
      : [
          {
            action: "the session worktree is removed — continue in the primary checkout on develop",
            kind: "required",
          },
        ],
  };
}
