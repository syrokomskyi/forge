/*
<MODULE_CONTRACT>
<purpose>flow.backmerge (RFC-1490) — brings main into develop through a
gated port branch. Every release tag pointing at a commit of develop..main
(oldest commit first, line order within a commit) names the port; the port
worktree merges main with the fixed message `release &lt;tags&gt; → develop`.
A clean merge integrates through the normal lock-held path; a conflict
leaves the merge in progress and reports the conflicted paths plus recovery
steps. --redo discards an existing port for the same mainSha first.</purpose>
<non-goals>
  <item>No rebase of the port — flow.integrate handles the FLOW-INT-09/10 checks.</item>
  <item>No fix releases — that is flow.cut's fix mode.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The port branch is kind `session` with a `port` registry payload — flow.integrate already owns the gate, ff, cleanup and backmerge journal event for port entries, so the clean path delegates to integrateFlowBranch under the lock.</item>
  <item>main ahead of develop without release tags refuses FLOW-BM-01 — the port message and registry payload both require ≥1 tag (main only advances through cuts, which always tag).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 5 — flow.backmerge with port branch, conflict reporting, --redo</item>
  <item>RFC-1490: step 5 — flow.backmerge (port branch, fixed merge message, conflict + --redo paths)</item>
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

import {
  branchExists,
  currentBranch,
  git,
  isAncestor,
  requireGit,
  statusTracked,
  topLevel,
} from "../git.ts";
import { LockTimeoutError, withFlowLock } from "../locks.ts";
import { discoverReleaseLines } from "../release-lines.ts";
import {
  commonGitDir,
  FlowRegistrySchemaError,
  INTEGRATE_LOCK_RELATIVE_PATH,
  readRegistry,
  registryPath,
} from "../registry.ts";
import { primaryWorktree } from "../worktree-path.ts";
import { discardFlowBranch } from "./flow-discard.ts";
import {
  INTEGRATE_LOCK_STALE_MS,
  INTEGRATE_LOCK_WAIT_MS,
  integrateFlowBranch,
} from "./flow-integrate.ts";
import { openFlowBranchCore } from "./flow-open.ts";

export interface FlowBackmergeData {
  status: "not-needed" | "dry-run" | "merged" | "conflict" | "refused";
  /** Release tags the port carries, oldest commit first. */
  tags: string[];
  mainSha: string | null;
  portBranch: string | null;
  portWorktree: string | null;
  conflictedPaths: string[];
  diagnostics: Diagnostic[];
}

function result(partial: Partial<FlowBackmergeData>): FlowBackmergeData {
  return {
    status: "refused",
    tags: [],
    mainSha: null,
    portBranch: null,
    portWorktree: null,
    conflictedPaths: [],
    diagnostics: [],
    ...partial,
  };
}

function refuse(
  ruleId: string,
  message: string,
  fixHint: string,
  partial?: Partial<FlowBackmergeData>,
): FlowBackmergeData {
  return result({
    ...partial,
    status: "refused",
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  });
}

/** `v0.1.1` → `port-v0-1-1`, `forge@2.0.0` → `port-forge-2-0-0`. */
function portSlug(tag: string): string {
  return `port-${tag.replace(/[.@]/g, "-")}`.replace(/-+/g, "-").replace(/-$/, "");
}

/**
 * Release tags pointing at commits of `develop..main` — oldest commit
 * first, the discovered line order within a single commit.
 */
async function pendingReleaseTags(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<string[]> {
  const revs = await git(repoRoot, io, ["rev-list", "--reverse", "develop..main"]);
  if (revs.exitCode !== 0 || revs.stdout.trim() === "") return [];
  const { lines } = await discoverReleaseLines(repoRoot, io);
  const prefixOf = new Map<string, number>(
    lines.map((l, i) => [l.tagPrefix, i] as const),
  );
  const ordered: string[] = [];
  for (const sha of revs.stdout.trim().split("\n")) {
    const pointing = await git(repoRoot, io, ["tag", "--points-at", sha.trim()]);
    if (pointing.exitCode !== 0) continue;
    const names = pointing.stdout
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && [...prefixOf.keys()].some((p) => t.startsWith(p)));
    names.sort(
      (a, b) =>
        Math.min(
          ...[...prefixOf.entries()].filter(([p]) => a.startsWith(p)).map(([, i]) => i),
        ) -
        Math.min(
          ...[...prefixOf.entries()].filter(([p]) => b.startsWith(p)).map(([, i]) => i),
        ),
    );
    ordered.push(...names);
  }
  return ordered;
}

export async function backmergeFlow(
  repoRoot: string,
  io: WorkspaceIO,
  opts: {
    redo: boolean;
    dryRun: boolean;
    now?: Date;
    onProgress?: (m: string) => void;
  },
): Promise<FlowBackmergeData> {
  const now = opts.now ?? new Date();

  if (!(await branchExists(repoRoot, io, "develop"))) {
    return refuse(
      "FLOW-BM-01",
      "repository is not adopted into the fixed branch model — no develop branch",
      "run pnpm exec forge flow.install first",
    );
  }
  if (
    !(await branchExists(repoRoot, io, "main")) ||
    (await isAncestor(repoRoot, io, "main", "develop"))
  ) {
    return result({ status: "not-needed" });
  }

  const tags = await pendingReleaseTags(repoRoot, io);
  const mainSha = (await git(repoRoot, io, ["rev-parse", "main"])).stdout.trim();
  if (tags.length === 0) {
    return refuse(
      "FLOW-BM-01",
      "main is ahead of develop but no release tags point at develop..main — nothing to port",
      "main should only advance through flow.cut/flow.fix releases; inspect refs/heads/main",
      { mainSha },
    );
  }

  const primary = await primaryWorktree(io, repoRoot);
  const primaryBranch = await currentBranch(primary, io);
  const primaryDirty = await statusTracked(primary, io);
  if (primaryBranch !== "develop" || primaryDirty.length > 0) {
    return refuse(
      "FLOW-BM-01",
      primaryBranch !== "develop"
        ? `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`
        : `primary worktree has ${primaryDirty.length} tracked uncommitted change(s)`,
      "switch the primary to develop and commit or revert its changes",
      { tags, mainSha },
    );
  }

  const common = await commonGitDir(io, repoRoot);
  let registry;
  try {
    registry = await readRegistry(io, common);
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`);
    }
    throw error;
  }
  const duplicates = registry.branches.filter((b) => b.port !== null && b.port.mainSha === mainSha);
  if (duplicates.length > 0 && !opts.redo) {
    return refuse(
      "FLOW-BM-02",
      `a port for main@${mainSha.slice(0, 9)} already exists: ${duplicates.map((b) => b.name).join(", ")}`,
      "finish it with flow.integrate, or re-run with --redo to reopen the port",
      { tags, mainSha },
    );
  }
  for (const dup of duplicates) {
    const discarded = await discardFlowBranch(repoRoot, io, {
      branch: dup.name,
      reason: "backmerge redo",
      dirty: true,
      dryRun: false,
      now,
    });
    if (discarded.diagnostics.some((d) => d.severity === "error")) {
      const d = discarded.diagnostics[0]!;
      return refuse(d.ruleId, d.message, d.fixHint ?? "inspect flow.status", { tags, mainSha });
    }
  }

  if (opts.dryRun) {
    return result({ status: "dry-run", tags, mainSha });
  }

  const message = `release ${tags.join(", ")} → develop`;
  const lockPath = join(common, INTEGRATE_LOCK_RELATIVE_PATH);
  let portBranch: string | null = null;
  try {
    return await withFlowLock(
      lockPath,
      {
        waitMs: INTEGRATE_LOCK_WAIT_MS,
        staleMs: INTEGRATE_LOCK_STALE_MS,
        progressEveryMs: 60_000,
        onProgress: opts.onProgress,
      },
      async () => {
        const open = await openFlowBranchCore(repoRoot, io, {
          kind: "session",
          slug: portSlug(tags[0]!),
          brief: `back-merge ${message}`,
          owner: { kind: "session", id: "backmerge" },
          port: { mainSha, tags },
          dryRun: false,
          now,
        });
        if (!open.opened || open.branch === null || open.worktree === null) {
          const d = open.diagnostics[0];
          return refuse(
            d?.ruleId ?? "FLOW-BM-01",
            d?.message ?? "port branch did not open",
            d?.fixHint ?? "inspect flow.status",
            { tags, mainSha },
          );
        }
        portBranch = open.branch;
        const wt = open.worktree;

        const merge = await git(wt, io, ["merge", "--no-ff", "-m", message, "main"], {
          env: { FORGE_FLOW_COMMIT: "backmerge" },
        });
        if (merge.exitCode !== 0) {
          const mergeHead = await git(wt, io, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
          if (mergeHead.exitCode !== 0) {
            return refuse(
              "FLOW-BM-01",
              `git merge --no-ff main failed without starting a merge (exit ${merge.exitCode}): ${merge.stderr.trim()}`,
              "inspect the port worktree state — the merge never began, so no resolution is pending",
              { tags, mainSha, portBranch, portWorktree: wt },
            );
          }
          const conflicts = await git(wt, io, ["diff", "--name-only", "--diff-filter=U"]);
          const paths = conflicts.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          return result({
            status: "conflict",
            tags,
            mainSha,
            portBranch,
            portWorktree: wt,
            conflictedPaths: paths,
            diagnostics: [
              {
                ruleId: "FLOW-BM-01",
                severity: "warning",
                message: `back-merge conflicts in: ${paths.join(", ") || "(unknown paths)"}`,
                fixHint: `resolve inside ${wt}, run git commit --no-edit, then pnpm exec forge flow.integrate --branch ${portBranch}`,
              },
            ],
          });
        }

        const integrated = await integrateFlowBranch(repoRoot, io, {
          branch: portBranch,
          dryRun: false,
          now,
          lockHeld: true,
          target: "develop",
        });
        if (!integrated.integrated || integrated.diagnostics.length > 0) {
          const d = integrated.diagnostics[0];
          return refuse(
            d?.ruleId ?? "FLOW-INT-05",
            d?.message ?? "port integration failed",
            d?.fixHint ?? "inspect the gate output",
            { tags, mainSha, portBranch, portWorktree: wt },
          );
        }
        return result({ status: "merged", tags, mainSha, portBranch, portWorktree: wt });
      },
      io,
    );
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return refuse(
        "FLOW-INT-08",
        `integration lock ${error.lockPath} is held by another integration`,
        "wait for the running integration to finish, or break the stale lock after 2 h automatically",
        { tags, mainSha, portBranch },
      );
    }
    throw error;
  }
}

export async function runFlowBackmerge(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowBackmergeData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.backmerge must run inside a git repository");
  }

  const data = await backmergeFlow(repoRoot, io, {
    redo: input.flags["redo"] === true,
    dryRun: context.dryRun || input.flags["dry-run"] === true,
  });

  const refused = data.diagnostics.find((d) => d.severity === "error");
  if (outputFormat === "pretty") {
    if (refused) {
      logger.error(`flow.backmerge refused: ${refused.ruleId} ${refused.message}`);
    } else if (data.status === "conflict") {
      logger.section("flow.backmerge");
      logger.info(`  conflict:  ${data.conflictedPaths.join(", ")}`);
      logger.info(`  worktree:  ${data.portWorktree}`);
      logger.info(`  next:      resolve, git commit --no-edit, flow.integrate --branch ${data.portBranch}`);
    } else {
      logger.info(`flow.backmerge ${data.status}: ${data.tags.join(", ")}`);
    }
  }

  return {
    data,
    exitCode: refused ? 1 : 0,
    summary:
      data.status === "conflict"
        ? `[flow.backmerge] conflict in ${data.conflictedPaths.join(", ")} — resolve in ${data.portWorktree}, commit --no-edit, flow.integrate`
        : refused
          ? `[flow.backmerge] refused: ${refused.ruleId} ${refused.message}`
          : `[flow.backmerge] ${data.status}${data.tags.length > 0 ? ` ${data.tags.join(", ")}` : ""}`,
  };
}
