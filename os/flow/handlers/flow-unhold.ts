/*
<MODULE_CONTRACT>
<purpose>flow.unhold — bring a held branch back to life (RFC-1491): create
the RFC-1487 sibling worktree at the branch tip, run hooks/worktree-setup.sh,
clear held, restore the worktree path and journal the unhold. The branch
then integrates normally via flow.integrate.</purpose>
<non-goals>
  <item>No hold — handlers/flow-hold.ts owns that direction.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 4 — flow.unhold (FLOW-HOLD-08, sibling worktree, held clear, journal)</item>
  <item>RFC-1491: step 4 — flow.hold replay + flow.unhold worktree restore</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
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
  git,
  requireGit,
  topLevel,
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
import { flowWorktreePath, primaryWorktree } from "../worktree-path.ts";

export interface FlowUnholdData {
  unheld: boolean;
  branch: string | null;
  worktree: string | null;
  setup: FlowScriptResult | null;
  diagnostics: Diagnostic[];
}

function refuse(ruleId: string, message: string, fixHint?: string): FlowUnholdData {
  return {
    unheld: false,
    branch: null,
    worktree: null,
    setup: null,
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

/**
 * Core of flow.unhold — callable with an injected clock. Every refusal is a
 * diagnostic in the returned data; nothing mutates unless unheld: true.
 */
export async function unholdFlowBranch(
  repoRoot: string,
  io: WorkspaceIO,
  opts: { branch: string; dryRun: boolean; now?: Date },
): Promise<FlowUnholdData> {
  const now = opts.now ?? new Date();
  const common = await commonGitDir(io, repoRoot);
  const primary = await primaryWorktree(io, repoRoot);

  let registry;
  try {
    registry = await readRegistry(io, common);
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`);
    }
    throw error;
  }
  const entry = registry.branches.find((b) => b.name === opts.branch);
  if (entry === undefined || entry.held === null) {
    return refuse(
      "FLOW-HOLD-08",
      entry === undefined
        ? `no registry entry for '${opts.branch}'`
        : `entry ${opts.branch} is not held`,
      "only branches held by flow.hold can be unheld — check flow.status",
    );
  }

  const worktree = flowWorktreePath(primary, entry.name);
  if (await io.exists(worktree)) {
    return refuse(
      "FLOW-HOLD-08",
      `target worktree path ${worktree} already exists`,
      "remove the stale directory first",
    );
  }

  if (opts.dryRun) {
    return { unheld: false, branch: entry.name, worktree, setup: null, diagnostics: [] };
  }

  try {
    const add = await git(primary, io, ["worktree", "add", worktree, entry.name]);
    if (add.exitCode !== 0) {
      return refuse(
        "FLOW-HOLD-08",
        `git worktree add ${worktree} failed: ${add.stderr.trim()}`,
      );
    }

    const setup = await runFlowScript(io, "worktree-setup", {
      primary,
      cwd: worktree,
      env: { FLOW_PRIMARY: primary, FLOW_BRANCH: entry.name },
    });

    const iso = now.toISOString();
    await updateRegistry(io, common, (r) => ({
      ...r,
      branches: r.branches.map((b) =>
        b.name === entry.name
          ? { ...b, held: null, worktree, updatedAt: iso }
          : b,
      ),
    }));
    await appendJournal(io, common, {
      at: iso,
      event: "unhold",
      branch: entry.name,
      sha: entry.held.tip,
      detail: `unheld — ${entry.held.reason}`,
    });

    // The unhold already landed (registry + journal) — a setup-hook failure
    // is a warning on the resulting worktree, not a refusal of the unhold.
    const diagnostics: Diagnostic[] =
      setup.status === "failed"
        ? [
            {
              ruleId: "FLOW-HOLD-08",
              severity: "warning",
              message: `hooks/worktree-setup.sh failed (exit ${setup.exitCode}): ${setup.stderrTail}`,
              fixHint: `fix ${primary}/hooks/worktree-setup.sh — the worktree ${worktree} and registry entry are kept`,
            },
          ]
        : [];
    return {
      unheld: true,
      branch: entry.name,
      worktree,
      setup,
      diagnostics,
    };
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return refuse(
        "FLOW-07",
        `registry lock ${error.lockPath} still held after 10 s`,
        "a live flow command holds the lock — retry, or remove it if the holder died",
      );
    }
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`);
    }
    throw error;
  }
}

export async function runFlowUnhold(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowUnholdData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io: WorkspaceIO = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.unhold must run inside a git repository");
  }

  const branch = typeof input.flags["branch"] === "string" ? input.flags["branch"] : "";
  if (branch.length === 0) {
    return {
      data: refuse("FLOW-HOLD-08", "--branch <held branch> is required"),
      exitCode: 1,
      summary: "[flow.unhold] missing --branch",
    };
  }

  const data = await unholdFlowBranch(repoRoot, io, {
    branch,
    dryRun: input.flags["dry-run"] === true,
  });
  const errors = data.diagnostics.filter((d) => d.severity === "error");

  if (outputFormat === "pretty") {
    for (const d of data.diagnostics) {
      if (d.severity === "error") logger.error(`  ${d.ruleId}: ${d.message}`);
      else logger.warn(`  ${d.ruleId}: ${d.message}`);
    }
    if (data.unheld) {
      logger.info(`  unheld ${data.branch} → ${data.worktree}`);
      logger.info(`  integrate with: pnpm exec forge flow.integrate --branch ${data.branch}`);
    }
  }

  return {
    data,
    exitCode: errors.length > 0 ? 1 : 0,
    summary: data.unheld
      ? `[flow.unhold] ${data.branch} unheld → ${data.worktree}`
      : `[flow.unhold] refused — ${errors.length} error(s)`,
  };
}
