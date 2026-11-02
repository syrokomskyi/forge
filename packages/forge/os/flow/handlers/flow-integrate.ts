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
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 4 — flow.integrate handler</item>
  <item>RFC-1487: step 4 — flow.integrate with lock, primary-side gate, ff-only merge and cleanup resume</item>
  <item>RFC-1487: close rfc-1487 review findings — dirty-check parity with git worktree remove, ownership-verified lock release, FLOW-07 registry-error mapping, residual RFC-1462 docs removed

The dirty gate for session worktrees now uses full porcelain status
(untracked files included) because it predicts 'git worktree remove';
the primary-clean gate keeps tracked-only semantics because it predicts
'merge --ff-only'. Lock release verifies the held payload before
unlinking. Registry/journal failures map to FLOW-07 in every handler.
The final branch-name collision reports FLOW-OPEN-04, flow.discard
propagates its teardown result and predicts FLOW-DIS-03 on --dry-run,
and integrate exposes teardown as its own field.</item>
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
  <item>RFC-1491: step 1 — journal base/rewrites + held registry widening, W1-1 discard tip, FLOW-INT-11</item>
</CHANGE_SUMMARY>
*/

import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import {
  branchExists,
  currentBranch,
  git,
  isAncestor,
  requireGit,
  statusDirty,
  statusTracked,
  topLevel,
  worktreeList,
} from "../git.ts";
import { LockTimeoutError, withFlowLock } from "../locks.ts";
import {
  appendJournal,
  commonGitDir,
  FlowRegistrySchemaError,
  INTEGRATE_LOCK_RELATIVE_PATH,
  readRegistry,
  registryPath,
  updateRegistry,
  type FlowRegistryEntry,
} from "../registry.ts";
import { runFlowScript, type FlowScriptResult } from "../scripts.ts";
import { primaryWorktree } from "../worktree-path.ts";
import { join } from "node:path";

export const INTEGRATE_LOCK_WAIT_MS = 30 * 60_000;
export const INTEGRATE_LOCK_STALE_MS = 2 * 3_600_000;

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
  diagnostics: Diagnostic[];
}

function refuse(
  ruleId: string,
  message: string,
  fixHint: string,
  partial?: Partial<FlowIntegrateData>,
): FlowIntegrateData {
  return {
    branch: partial?.branch ?? null,
    integrated: partial?.integrated ?? false,
    developBefore: partial?.developBefore ?? null,
    developAfter: partial?.developAfter ?? partial?.developBefore ?? null,
    rebased: partial?.rebased ?? false,
    gate: partial?.gate ?? null,
    cleanedUp: partial?.cleanedUp ?? false,
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
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
): Promise<{ cleanedUp: boolean; diagnostics: Diagnostic[]; gate: FlowScriptResult | null }> {
  const branchExistsNow = await branchExists(primary, io, entry.name);
  let teardownRan: FlowScriptResult | null = null;
  if (worktree !== null && (await io.exists(worktree))) {
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
    const del = await git(primary, io, ["branch", "-d", entry.name]);
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
 */
export async function integrateFlowBranch(
  repoRoot: string,
  io: WorkspaceIO,
  opts: {
    branch: string | null;
    dryRun: boolean;
    now?: Date;
    onProgress?: (m: string) => void;
    /** Caller already holds the integration lock (flow.cut/fix releases). */
    lockHeld?: boolean;
    /** Gate target — passed to the integration gate as FORGE_FLOW_TARGET. */
    target?: "develop" | "main";
  },
): Promise<FlowIntegrateData> {
  const now = opts.now ?? new Date();

  const branch =
    opts.branch ?? (await currentBranch(repoRoot, io));
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
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(await commonGitDir(io, repoRoot))}`);
    }
    throw error;
  }
  const { common, entry } = resolved;
  if (entry === null) {
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
      return {
        branch,
        integrated: false,
        developBefore: null,
        developAfter: null,
        rebased: false,
        gate: null,
        cleanedUp: false,
        diagnostics: [
          {
            ruleId: "FLOW-07",
            severity: "error",
            message: `registry entry for ${branch} names worktree ${wtPath}, which does not exist`,
            fixHint: "inspect with flow.status — a stale entry may need flow.discard",
          },
        ],
      };
    }
    const dirty = await statusDirty(wtPath, io);
    return {
      branch,
      integrated: false,
      developBefore: null,
      developAfter: null,
      rebased: false,
      gate: null,
      cleanedUp: false,
      diagnostics:
        dirty.length > 0
          ? [
              {
                ruleId: "FLOW-INT-01",
                severity: "error",
                message: `worktree ${wtPath} has ${dirty.length} uncommitted change(s)`,
                fixHint: "commit or revert the uncommitted changes inside the session worktree",
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

        // (2) the branch worktree must exist and be clean.
        const worktrees = await worktreeList(primary, io);
        const branchWorktree =
          worktrees.find((w) => w.branch === branch)?.path ?? entry.worktree;
        if (branchWorktree === null || !(await io.exists(branchWorktree))) {
          return refuse(
            "FLOW-07",
            `registry entry for ${branch} names worktree ${branchWorktree}, which does not exist`,
            "inspect with flow.status — a stale entry may need flow.discard",
            { branch, developBefore },
          );
        }
        const dirty = await statusDirty(branchWorktree, io);
        if (dirty.length > 0) {
          return refuse(
            "FLOW-INT-01",
            `worktree ${branchWorktree} has ${dirty.length} uncommitted change(s): ${dirty.slice(0, 10).join(", ")}`,
            "commit or revert the uncommitted changes inside the session worktree, then re-run",
            { branch, developBefore },
          );
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
        const rebaseBase = (await git(primary, io, ["rev-parse", "develop"])).stdout.trim();
        const rebase =
          entry.port !== null
            ? { exitCode: 0, stdout: "", stderr: "" }
            : await git(branchWorktree, io, ["rebase", "develop"]);
        if (rebase.exitCode !== 0) {
          const conflicts = await git(branchWorktree, io, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]);
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

        // (4) integration gate — the primary's copy gates the branch.
        const gate = await runFlowScript(io, "integration-gate", {
          primary,
          cwd: branchWorktree,
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
          );
        }

        // (5) primary must sit clean on develop, then fast-forward.
        const primaryBranch = await currentBranch(primary, io);
        const primaryDirty = await statusTracked(primary, io);
        if (primaryBranch !== "develop" || primaryDirty.length > 0) {
          return refuse(
            "FLOW-INT-03",
            primaryBranch !== "develop"
              ? `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`
              : `primary worktree has ${primaryDirty.length} uncommitted change(s)`,
            "switch the primary to develop and commit or revert its tracked changes, then re-run — the branch stays rebased",
            { branch, developBefore, rebased: entry.port === null, gate },
          );
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
          diagnostics: [],
        };
  };

  let inner: FlowIntegrateData;
  try {
    inner = opts.lockHeld === true
      ? await integrateInner()
      : await withFlowLock(
          lockPath,
          {
            waitMs: INTEGRATE_LOCK_WAIT_MS,
            staleMs: INTEGRATE_LOCK_STALE_MS,
            progressEveryMs: 60_000,
            onProgress: opts.onProgress,
            onStale: (l) =>
              opts.onProgress?.(
                `broke stale integration lock (held since ${l.at}, ${Math.round(l.ageMs / 60000)} min old)`,
              ),
          },
          integrateInner,
          io,
        );
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return refuse(
        "FLOW-INT-08",
        `integration lock ${error.lockPath} is held by another integration`,
        "wait for the running integration to finish, or break the stale lock after 2 h automatically",
        { branch },
      );
    }
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`, { branch });
    }
    throw error;
  }

  if (!inner.integrated || inner.diagnostics.length > 0) return inner;

  // (6) cleanup — outside the lock; every git call runs with -C primary.
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
  });

  const refused = data.diagnostics.find((d) => d.severity === "error");
  if (outputFormat === "pretty") {
    if (refused) {
      logger.error(`flow.integrate refused: ${refused.message}`);
    } else {
      logger.section("flow.integrate");
      logger.info(`  branch:    ${data.branch}`);
      logger.info(`  integrated: ${data.integrated}${data.rebased ? " (rebased)" : ""}`);
      logger.info(`  develop:   ${data.developBefore?.slice(0, 9)} → ${data.developAfter?.slice(0, 9)}`);
      logger.info(`  cleanedUp: ${data.cleanedUp}`);
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
