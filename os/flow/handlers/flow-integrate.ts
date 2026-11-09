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
  <item>RFC-1538: revalidate integration preconditions post-lock and reuse the session engine</item>
  <item>RFC-1531: remediation flags --reattach/--auto-clean/--autocommit on the classified dirty set, FLOW-INT-17 remediation-failure refusals, classified FLOW-INT-01 data</item>
  <item>RFC-1532: persist integration-gate reports per attempt and link them from the flow journal</item>
  <item>RFC-1545: standalone generated-conflict regeneration in flow.integrate</item>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
  <history>RFC-1487, RFC-1490, RFC-1491, RFC-1504, RFC-1509, RFC-1515, RFC-1528, RFC-1536, RFC-1537</history>
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
import { standaloneInvoke } from "../standalone-invoke.ts";
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
  /** RFC-1538: which checkout's build ran the integration gate. */
  gateEngine?: "session" | "primary";
  /** RFC-1531: worktree path --reattach created this run. */
  reattachedTo?: string;
  /** RFC-1531: reattach target a --dry-run reports without mutating. */
  wouldReattach?: string;
  /** RFC-1531: disposable-class paths --auto-clean deleted this run. */
  autoCleaned?: string[];
  /** RFC-1531: sha of the --autocommit sweep commit (SWEEP_COMMIT_SUBJECT). */
  autocommitSha?: string;
  /** RFC-1515: holder payload when FLOW-INT-08 refused on a held lock. */
  lock?: LockDiagnostic;
  diagnostics: Diagnostic[];
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
    ...(partial?.lock !== undefined ? { lock: partial.lock } : {}),
    diagnostics: [
      { ruleId, severity: "error", message, fixHint, ...(diagData ? { data: diagData } : {}) },
    ],
  };
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
  journalRemediation?: { reattachedTo?: string; autoCleaned?: string[]; autocommitSha?: string },
  journalGateReport?: string,
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
      ...(journalGateReport !== undefined ? { gateReport: journalGateReport } : {}),
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

async function integrateFlowBranchAttempt(
  repoRoot: string,
  io: WorkspaceIO,
  opts: {
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
  },
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
  const integrateInner = async (): Promise<FlowIntegrateData> => {
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
        return refuse(
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
          },
          preflight.refuse.data,
        );
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

    // (3) rebase onto the current develop — never for port entries.
    // RFC-1538: a conflict confined to generated artifacts resolves via its
    // owner command (checkout --theirs + regenerate + continue) — the
    // generated-file doctrine applied inside the rebase path; anything else
    // still refuses FLOW-INT-02 for a human.
    const rebaseBase = (await git(primary, io, ["rev-parse", "develop"])).stdout.trim();
    const autoResolved: string[] = [];
    if (entry.port === null) {
      let rebase = await git(branchWorktree, io, ["rebase", "develop"]);
      let guard = 0;
      while (rebase.exitCode !== 0 && guard++ < 8) {
        const conflicts = await git(branchWorktree, io, ["diff", "--name-only", "--diff-filter=U"]);
        const paths = conflicts.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const { classifyRebaseConflicts } = await import("../preflight.ts");
        const verdict = await classifyRebaseConflicts(branchWorktree, io, paths);
        // RFC-1545 AC-2: without a kernel invoke port the standalone adapter
        // spawns the allowlisted owner commands in the worktree — the
        // resolution contract is identical either way.
        const invoker =
          opts.invoke ??
          standaloneInvoke(
            io,
            branchWorktree,
            verdict.owners.map((o) => o.command),
          );
        const resolvable =
          paths.length > 0 &&
          verdict.nonGenerated.length === 0 &&
          verdict.owners.length === paths.length;
        if (!resolvable) {
          await git(branchWorktree, io, ["rebase", "--abort"]);
          return refuse(
            "FLOW-INT-02",
            `rebase onto develop conflicts in: ${paths.join(", ") || "(unknown paths)"}` +
              (verdict.owners.length > 0 ? " — mixed generated/non-generated conflict set" : ""),
            "resolve the rebase inside the session worktree, commit, and re-run flow.integrate",
            { branch, developBefore },
          );
        }
        let failed = false;
        for (const o of verdict.owners) {
          // `git checkout --theirs` is blocked by the agent-session git
          // wrapper — materialize the stage-3 (theirs) blob through the
          // read-only `git show` + io write instead (RFC-1545).
          const theirs = await git(branchWorktree, io, ["show", `:3:${o.path}`]);
          if (theirs.exitCode === 0) {
            await io.writeFile(join(branchWorktree, o.path), theirs.stdout);
          }
          const regen = await invoker(o.command, o.flags);
          if (regen.ok === false || (regen.exitCode !== undefined && regen.exitCode !== 0)) {
            await git(branchWorktree, io, ["rebase", "--abort"]);
            failed = true;
            return refuse(
              "FLOW-INT-02",
              `auto-resolve of generated conflict ${o.path} failed: ${o.command} — ${regen.summary ?? `exit ${regen.exitCode}`}`,
              "resolve the rebase inside the session worktree manually, commit, and re-run flow.integrate",
              { branch, developBefore },
            );
          }
          // RFC-1545 AC-4: a successful generator that left conflict markers
          // behind must not be committed — escalate like a failure.
          const regenerated = await io.readFile(join(branchWorktree, o.path));
          if (/^(<{7}|={7}|>{7})/m.test(regenerated)) {
            await git(branchWorktree, io, ["rebase", "--abort"]);
            failed = true;
            return refuse(
              "FLOW-INT-02",
              `auto-resolve of generated conflict ${o.path} failed: ${o.command} left conflict markers in the regenerated output`,
              "resolve the rebase inside the session worktree manually, commit, and re-run flow.integrate",
              { branch, developBefore },
            );
          }
          await git(branchWorktree, io, ["add", "--", o.path]);
          opts.onProgress?.(`conflict: ${o.path} — regenerated via ${o.command}`);
          autoResolved.push(o.path);
        }
        if (failed) break;
        rebase = await git(branchWorktree, io, ["-c", "core.editor=true", "rebase", "--continue"]);
      }
      if (rebase.exitCode !== 0) {
        const conflicts = await git(branchWorktree, io, ["diff", "--name-only", "--diff-filter=U"]);
        const paths = conflicts.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        await git(branchWorktree, io, ["rebase", "--abort"]);
        return refuse(
          "FLOW-INT-02",
          `rebase onto develop conflicts in: ${paths.join(", ") || "(unknown paths)"}`,
          "resolve the rebase inside the session worktree, commit, and re-run flow.integrate",
          { branch, developBefore },
        );
      }
    }

    // (4) integration gate — the primary's script, executed by the session
    // engine's build when the worktree carries one (RFC-1538): the code
    // under review judges itself; the checks it faces stay primary-owned.
    const { resolveGateEngine } = await import("../gate-engine.ts");
    const engine = await resolveGateEngine(branchWorktree, primary, io);
    const warnings: Diagnostic[] = [];
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
      ...(dirty.toleratedState.length > 0 ? { toleratedState: dirty.toleratedState } : {}),
      ...(toleratedDirt.length > 0 ? { toleratedDirt } : {}),
      ...(autoResolved.length > 0 ? { autoResolved } : {}),
      ...(reattachedTo !== undefined ? { reattachedTo } : {}),
      ...(autoCleaned !== undefined && autoCleaned.length > 0 ? { autoCleaned } : {}),
      ...(autocommitSha !== undefined ? { autocommitSha } : {}),
      gateEngine: engine.source,
      diagnostics: warnings,
    };
  };

  let inner: FlowIntegrateData;
  try {
    inner =
      opts.lockHeld === true
        ? await integrateInner()
        : await withFlowLock(
            lockPath,
            {
              waitMs: opts.lockWaitMs ?? INTEGRATE_LOCK_WAIT_MS,
              staleMs: INTEGRATE_LOCK_STALE_MS,
              progressEveryMs: 60_000,
              onProgress: opts.onProgress,
              onStale: (l) =>
                opts.onProgress?.(
                  l.reason === "dead-holder"
                    ? `broke dead-holder integration lock (pid ${l.pid ?? "?"} on ${l.host ?? "?"}, held since ${l.at})`
                    : `broke stale integration lock (held since ${l.at}, ${Math.round(l.ageMs / 60000)} min old)`,
                ),
            },
            integrateInner,
            io,
          );
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
    },
    inner.gate?.reportPath ?? undefined,
  );
  return {
    ...inner,
    gate: inner.gate,
    teardown: cleanup.gate,
    cleanedUp: cleanup.cleanedUp,
    diagnostics: cleanup.diagnostics,
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
    waitForeignSeconds:
      typeof input.flags["wait-foreign"] === "string" ||
      typeof input.flags["wait-foreign"] === "number"
        ? Number(input.flags["wait-foreign"])
        : undefined,
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
