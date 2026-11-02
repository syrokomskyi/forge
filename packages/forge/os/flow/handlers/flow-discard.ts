/*
<MODULE_CONTRACT>
<purpose>flow.discard — drop a registered auto branch without integrating
(RFC-1487). Refuses on a held entry (FLOW-DIS-01), a teardown refusal
(FLOW-DIS-02), or a dirty worktree without --dirty (FLOW-DIS-03). Removes
the worktree (--force only with --dirty), force-deletes the branch, drops
the registry entry and journals the operator's reason.</purpose>
<non-goals>
  <item>No branch rescue — discard is the operator's explicit drop; the reason is journaled for the outbound wave.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Dirty check runs before the teardown script — a discard we will refuse on dirt never executes repository code.</item>
  <item>`git branch -D` (not -d): a discarded branch is by definition unmerged.</item>
  <item>All post-removal git calls run with -C &lt;primary&gt; — the caller's cwd may be the removed worktree (AUDIT G3).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 5 — flow.discard handler</item>
  <item>RFC-1487: step 5 — flow.discard, flow.status, flow.check FLOW-06/07</item>
  <item>RFC-1487: close rfc-1487 review findings — dirty-check parity with git worktree remove, ownership-verified lock release, FLOW-07 registry-error mapping, residual RFC-1462 docs removed

The dirty gate for session worktrees now uses full porcelain status
(untracked files included) because it predicts 'git worktree remove';
the primary-clean gate keeps tracked-only semantics because it predicts
'merge --ff-only'. Lock release verifies the held payload before
unlinking. Registry/journal failures map to FLOW-07 in every handler.
The final branch-name collision reports FLOW-OPEN-04, flow.discard
propagates its teardown result and predicts FLOW-DIS-03 on --dry-run,
and integrate exposes teardown as its own field.</item>
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
  requireGit,
  statusDirty,
  topLevel,
  worktreeList,
} from "../git.ts";
import { LockTimeoutError } from "../locks.ts";
import {
  appendJournal,
  commonGitDir,
  FlowRegistrySchemaError,
  readRegistry,
  registryPath,
  updateRegistry,
} from "../registry.ts";
import { runFlowScript, type FlowScriptResult } from "../scripts.ts";
import { primaryWorktree } from "../worktree-path.ts";

export interface FlowDiscardData {
  branch: string | null;
  discarded: boolean;
  reason: string | null;
  teardown: FlowScriptResult | null;
  diagnostics: Diagnostic[];
}

function refuse(
  ruleId: string,
  message: string,
  fixHint: string,
  partial?: Partial<FlowDiscardData>,
): FlowDiscardData {
  return {
    branch: partial?.branch ?? null,
    discarded: false,
    reason: partial?.reason ?? null,
    teardown: partial?.teardown ?? null,
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

/**
 * Core of flow.discard — the reason is required (journaled so the outbound
 * wave can tell a dropped session from an integrated one).
 */
export async function discardFlowBranch(
  repoRoot: string,
  io: WorkspaceIO,
  opts: {
    branch: string | null;
    reason: string | null;
    dirty: boolean;
    dryRun: boolean;
    now?: Date;
  },
): Promise<FlowDiscardData> {
  const now = opts.now ?? new Date();

  if (opts.reason === null || opts.reason.trim() === "") {
    return refuse(
      "FLOW-DIS-04",
      "--reason is required — the journal records why the work was dropped",
      "re-run with --reason \"<operator's words>\"",
    );
  }

  const branch = opts.branch ?? (await currentBranch(repoRoot, io));
  if (branch === null) {
    return refuse(
      "FLOW-DIS-04",
      "no --branch given and the current worktree is not on a branch",
      "pass --branch auto/<kind>-<YYMMDD>-<NN>-<slug> explicitly",
    );
  }

  const common = await commonGitDir(io, repoRoot);
  let entry;
  try {
    entry = (await readRegistry(io, common)).branches.find((b) => b.name === branch) ?? null;
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`, { branch });
    }
    throw error;
  }
  if (entry === null) {
    return refuse(
      "FLOW-DIS-04",
      `${branch} is not a registered session/task branch`,
      "check flow.status for registered entries; delete plain branches with git branch -D",
      { branch },
    );
  }
  if (entry.held !== null) {
    return refuse(
      "FLOW-DIS-01",
      `${branch} is held — held branches are never discarded`,
      "release the hold first (the wave-2 outbound RFC defines flow.unhold)",
      { branch },
    );
  }

  const primary = await primaryWorktree(io, repoRoot);
  const worktrees = await worktreeList(primary, io);
  const worktree = worktrees.find((w) => w.branch === branch)?.path ?? entry.worktree;

  const worktreePresent = worktree !== null && (await io.exists(worktree));
  if (opts.dryRun) {
    const dirty = worktreePresent ? await statusDirty(worktree, io) : [];
    return {
      branch,
      discarded: false,
      reason: opts.reason,
      teardown: null,
      diagnostics:
        dirty.length > 0 && !opts.dirty
          ? [
              {
                ruleId: "FLOW-DIS-03",
                severity: "error",
                message: `worktree ${worktree} has ${dirty.length} uncommitted change(s): ${dirty.slice(0, 10).join(", ")}`,
                fixHint:
                  "re-run with --dirty to acknowledge discarding the uncommitted changes, or commit/integrate them first",
              },
            ]
          : [],
    };
  }

  let teardownRan: FlowScriptResult | null = null;
  if (worktreePresent) {
    const dirty = await statusDirty(worktree, io);
    if (dirty.length > 0 && !opts.dirty) {
      return refuse(
        "FLOW-DIS-03",
        `worktree ${worktree} has ${dirty.length} uncommitted change(s): ${dirty.slice(0, 10).join(", ")}`,
        "re-run with --dirty to acknowledge discarding the uncommitted changes, or commit/integrate them first",
        { branch },
      );
    }

    const teardown = await runFlowScript(io, "worktree-teardown", {
      primary,
      cwd: worktree,
      env: { FLOW_PRIMARY: primary, FLOW_BRANCH: branch, FLOW_ACTION: "discard" },
    });
    teardownRan = teardown;
    if (teardown.status === "failed") {
      return refuse(
        "FLOW-DIS-02",
        `hooks/worktree-teardown.sh refused the discard (exit ${teardown.exitCode}): ${teardown.stderrTail}`,
        `resolve what ${primary}/hooks/worktree-teardown.sh demands, then re-run`,
        { branch, teardown },
      );
    }

    const rmArgs = ["worktree", "remove"];
    if (opts.dirty) rmArgs.push("--force");
    rmArgs.push(worktree);
    const remove = await git(primary, io, rmArgs);
    if (remove.exitCode !== 0) {
      return refuse(
        "FLOW-DIS-02",
        `git worktree remove ${worktree} failed: ${remove.stderr.trim()}`,
        "clear the blocker and re-run — the branch and registry entry are kept",
        { branch, teardown },
      );
    }
  }

  // W1-1: the journal records the tip being deleted, not the base — capture
  // it before `branch -D`.
  const deletedTip = (await branchExists(primary, io, branch))
    ? (await git(primary, io, ["rev-parse", branch])).stdout.trim()
    : entry.baseSha;
  if (await branchExists(primary, io, branch)) {
    const del = await git(primary, io, ["branch", "-D", branch]);
    if (del.exitCode !== 0) {
      return refuse(
        "FLOW-DIS-02",
        `git branch -D ${branch} failed: ${del.stderr.trim()}`,
        "inspect the git error — the registry entry is kept for a re-run",
        { branch },
      );
    }
  }

  try {
    await updateRegistry(io, common, (r) => ({
      ...r,
      branches: r.branches.filter((b) => b.name !== branch),
    }));
    await appendJournal(io, common, {
      at: now.toISOString(),
      event: "discard",
      branch,
      sha: deletedTip,
      base: entry.baseSha,
      detail: opts.reason,
    });
  } catch (error) {
    if (error instanceof LockTimeoutError || error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`, {
        branch,
        reason: opts.reason,
        teardown: teardownRan,
      });
    }
    throw error;
  }

  return {
    branch,
    discarded: true,
    reason: opts.reason,
    teardown: teardownRan,
    diagnostics: [],
  };
}

export async function runFlowDiscard(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowDiscardData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.discard must run inside a git repository");
  }

  const branchFlag = input.flags["branch"];
  const reasonFlag = input.flags["reason"];
  const data = await discardFlowBranch(repoRoot, io, {
    branch: typeof branchFlag === "string" ? branchFlag : null,
    reason: typeof reasonFlag === "string" ? reasonFlag : null,
    dirty: input.flags["dirty"] === true,
    dryRun: context.dryRun || input.flags["dry-run"] === true,
  });

  const refused = data.diagnostics.find((d) => d.severity === "error");
  if (outputFormat === "pretty") {
    if (refused) logger.error(`flow.discard refused: ${refused.message}`);
    else logger.info(`discarded ${data.branch} — ${data.reason}`);
  }

  return {
    data,
    exitCode: refused ? 1 : 0,
    summary: refused
      ? `[flow.discard] refused: ${refused.ruleId} ${refused.message}`
      : `[flow.discard] discarded ${data.branch} (${data.reason})`,
  };
}
