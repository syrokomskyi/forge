/*
<MODULE_CONTRACT>
<purpose>flow.hold — pull one integration item out of the unpushed develop
tail (RFC-1491): refuse per FLOW-HOLD-01..06, then under the integration
lock cherry-pick the tail above the item into a detached temporary
worktree, keep a held auto branch at the item's tip, reset develop to the
replayed tip and journal the hold with per-item rewrites.</purpose>
<non-goals>
  <item>No unhold — handlers/flow-unhold.ts owns that direction.</item>
  <item>No push — the held work stays local until flow.push.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>All refusals happen before any mutation; a cherry-pick conflict aborts and removes the temporary worktree so FLOW-HOLD-07 leaves nothing changed.</item>
  <item>Rewrites are journaled only for attributed replayed items — unattributed runs re-form from unclaimed commits on the new tail on their own.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 4 — flow.hold (replay, held branch, registry held entry, journal rewrites)</item>
  <item>RFC-1491: step 4 — flow.hold replay + flow.unhold worktree restore</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
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
import { formatFlowBranch, parseFlowBranch } from "../branch-name.ts";
import { collectDigest, type FlowDigestItem } from "../digest.ts";
import {
  git,
  gitCommit,
  listLocalBranches,
  listRemoteBranches,
  requireGit,
  statusTracked,
  topLevel,
} from "../git.ts";
import { LockTimeoutError, withFlowLock } from "../locks.ts";
import { INTEGRATE_LOCK_STALE_MS, INTEGRATE_LOCK_WAIT_MS } from "./flow-integrate.ts";
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
import { primaryWorktree } from "../worktree-path.ts";
import { nextFlowSeq } from "./flow-open.ts";

export interface FlowHoldData {
  held: boolean;
  item: string | null;
  branch: string | null;
  replayedTip: string | null;
  rewrites: Array<{
    branch: string;
    kind: "integration" | "backmerge" | "release";
    base: string;
    sha: string;
  }>;
  diagnostics: Diagnostic[];
}

function refuse(ruleId: string, message: string, fixHint?: string): FlowHoldData {
  return {
    held: false,
    item: null,
    branch: null,
    replayedTip: null,
    rewrites: [],
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

async function isAncestor(
  repoRoot: string,
  io: WorkspaceIO,
  older: string,
  newer: string,
): Promise<boolean> {
  const r = await git(repoRoot, io, ["merge-base", "--is-ancestor", older, newer]);
  return r.exitCode === 0;
}

/**
 * The hold's held-branch name: `auto/<kind>-<YYMMDD>-<NN>-held-<slug>` with
 * the original slug truncated to 43 chars and a dangling `-` dropped
 * (AUDIT-RFC-1491-G2 — stays within the 48-char slug limit).
 */
export function heldBranchName(
  itemBranch: string,
  candidates: string[],
  now: Date,
): string | null {
  const parsed = parseFlowBranch(itemBranch);
  if (parsed === null) return null;
  const truncated = parsed.slug.slice(0, 43).replace(/-+$/, "");
  const slug = `held-${truncated}`;
  if (slug.length > 48) return null;
  const yy = String(now.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const seq = nextFlowSeq(candidates, `${yy}${mm}${dd}`);
  if (seq > 99) return null;
  return formatFlowBranch({ kind: parsed.kind, date: now, seq, slug });
}

/**
 * Core of flow.hold — callable with an injected clock. Every refusal is a
 * diagnostic in the returned data; nothing mutates unless held: true.
 */
export async function holdFlowItem(
  repoRoot: string,
  io: WorkspaceIO,
  opts: { item: string; reason: string; dryRun: boolean; now?: Date },
): Promise<FlowHoldData> {
  const now = opts.now ?? new Date();
  let digest: Awaited<ReturnType<typeof collectDigest>>;
  try {
    digest = await collectDigest(repoRoot, io, { fetch: true });
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message);
    }
    throw error;
  }
  const item = digest.items.find((i) => i.id === opts.item) as FlowDigestItem | undefined;
  if (item === undefined) {
    return refuse(
      "FLOW-HOLD-01",
      `item '${opts.item}' is not in a freshly computed digest — run flow.digest and quote a current item id`,
    );
  }

  if (item.kind !== "integration") {
    return refuse(
      "FLOW-HOLD-05",
      `item ${item.id} is a ${item.kind} item — only integration items can be held`,
      "releases, back-merges and unattributed commits cannot be held; discard or discard-resolve them instead",
    );
  }

  // FLOW-HOLD-02: an unpushed release tag above the item's base would lose
  // its commit — "already released locally".
  for (const tag of digest.tags) {
    const tagged = await git(repoRoot, io, ["rev-list", "-1", tag]);
    if (tagged.exitCode !== 0) continue;
    const commit = tagged.stdout.trim();
    if (
      (await isAncestor(repoRoot, io, commit, "develop")) &&
      !(await isAncestor(repoRoot, io, commit, item.base))
    ) {
      return refuse(
        "FLOW-HOLD-02",
        `release tag ${tag} points at a commit above ${item.base.slice(0, 9)} — the work is already released locally`,
        "push first (flow.push) or delete the tag if it was created in error",
      );
    }
  }

  const common = await commonGitDir(io, repoRoot);
  const primary = await primaryWorktree(io, repoRoot);

  // FLOW-HOLD-03: an open entry rebased later would resurrect held commits.
  let registry;
  try {
    registry = await readRegistry(io, common);
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`);
    }
    throw error;
  }
  for (const entry of registry.branches) {
    if (entry.held !== null) continue;
    if (
      (await isAncestor(repoRoot, io, entry.baseSha, "develop")) &&
      !(await isAncestor(repoRoot, io, entry.baseSha, item.base))
    ) {
      return refuse(
        "FLOW-HOLD-03",
        `open branch ${entry.name} is based above ${item.base.slice(0, 9)} — a later rebase would bring the held commits back`,
        "integrate or discard it first, then re-run flow.hold",
      );
    }
  }

  const primaryBranch = (
    await git(primary, io, ["symbolic-ref", "--short", "-q", "HEAD"])
  ).stdout.trim();
  const dirty = await statusTracked(primary, io);
  if (primaryBranch !== "develop" || dirty.length > 0) {
    return refuse(
      "FLOW-HOLD-04",
      primaryBranch !== "develop"
        ? `the primary worktree is on ${primaryBranch || "detached HEAD"}, not develop`
        : `the primary worktree is dirty (${dirty.length} tracked change(s))`,
      "switch the primary to develop and commit or stash its changes",
    );
  }

  const merges = await git(repoRoot, io, ["rev-list", "--merges", `${item.tip}..develop`]);
  if (merges.exitCode === 0 && merges.stdout.trim().length > 0) {
    return refuse(
      "FLOW-HOLD-06",
      `a merge commit lies above ${item.id} on the tail — cherry-pick replay cannot reorder merges`,
      "the tail above the item must be linear; resolve the merge first",
    );
  }

  // Held branch name — allocated before the lock so a refusal is cheap.
  const [local, remote] = await Promise.all([
    listLocalBranches(repoRoot, io),
    listRemoteBranches(repoRoot, io),
  ]);
  const remoteNames = remote.map((r) => r.slice(r.indexOf("/") + 1));
  const candidates = [
    ...local,
    ...remoteNames,
    ...registry.branches.map((b) => b.name),
    item.branch ?? "",
  ];
  const heldName = heldBranchName(item.branch ?? "", candidates, now);
  if (heldName === null) {
    return refuse(
      "FLOW-HOLD-01",
      `cannot derive a held branch name from '${item.branch}' — 99 held branches today or an unparseable branch`,
    );
  }

  if (opts.dryRun) {
    return {
      held: false,
      item: item.id,
      branch: heldName,
      replayedTip: null,
      rewrites: [],
      diagnostics: [],
    };
  }

  const lockPath = join(common, INTEGRATE_LOCK_RELATIVE_PATH);
  try {
    return await withFlowLock(
      lockPath,
      { waitMs: INTEGRATE_LOCK_WAIT_MS, staleMs: INTEGRATE_LOCK_STALE_MS },
      () => executeHold(repoRoot, primary, common, io, item, heldName, digest, opts.reason, now),
      io,
    );
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return refuse(
        "FLOW-07",
        `integration lock ${error.lockPath} still held`,
        "a live flow command holds the lock — retry, or remove it if the holder died",
      );
    }
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`);
    }
    throw error;
  }
}

async function executeHold(
  repoRoot: string,
  primary: string,
  common: string,
  io: WorkspaceIO,
  item: FlowDigestItem,
  heldName: string,
  digest: Awaited<ReturnType<typeof collectDigest>>,
  reason: string,
  now: Date,
): Promise<FlowHoldData> {
  const holdWorktree = join(common, "forge", "hold-worktree");
  let worktreeAdded = false;
  try {
    // A stale temp worktree from a crashed hold is reclaimed first.
    if (await io.exists(holdWorktree)) {
      await git(repoRoot, io, ["worktree", "remove", "--force", holdWorktree]);
    }
    const add = await git(repoRoot, io, [
      "worktree",
      "add",
      "--detach",
      holdWorktree,
      item.base,
    ]);
    if (add.exitCode !== 0) {
      return refuse(
        "FLOW-HOLD-07",
        `temporary hold worktree could not be created: ${add.stderr.trim()}`,
      );
    }
    worktreeAdded = true;

    const pick = await gitCommit(holdWorktree, io, [
      "cherry-pick",
      "--keep-redundant-commits",
      "--allow-empty",
      `${item.tip}..develop`,
    ], "hold");
    if (pick.exitCode !== 0) {
      const conflicts = await git(holdWorktree, io, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
      const paths = conflicts.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      await git(holdWorktree, io, ["cherry-pick", "--abort"]);
      const detail = paths.length > 0
        ? `conflicts on ${paths.join(", ")}`
        : `failed: ${pick.stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}`;
      return refuse(
        "FLOW-HOLD-07",
        `replaying the tail above ${item.id} ${detail} — nothing changed`,
        "resolve the conflict by reordering the work, or drop the hold idea",
      );
    }

    const replayedTip = (await git(holdWorktree, io, ["rev-parse", "HEAD"])).stdout.trim();

    // New ranges of the replayed attributed items — each keeps its commit
    // count (keep-redundant), partitioned over the new tail in order.
    const newTail = await git(repoRoot, io, [
      "rev-list",
      "--reverse",
      `${item.base}..${replayedTip}`,
    ]);
    const newCommits = newTail.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const heldIndex = digest.items.findIndex((i) => i.id === item.id);
    const rewrites: FlowHoldData["rewrites"] = [];
    let offset = 0;
    for (const replayed of digest.items.slice(heldIndex + 1)) {
      const base = offset === 0 ? item.base : rewritesBase(newCommits, offset - 1);
      const sha = newCommits[offset + replayed.commits - 1] ?? replayedTip;
      if (replayed.branch !== null) {
        rewrites.push({
          branch: replayed.branch,
          kind: replayed.kind as "integration" | "backmerge" | "release",
          base,
          sha,
        });
      }
      offset += replayed.commits;
    }

    const branch = await git(repoRoot, io, ["branch", heldName, item.tip]);
    if (branch.exitCode !== 0) {
      return refuse(
        "FLOW-HOLD-07",
        `git branch ${heldName} failed: ${branch.stderr.trim()}`,
      );
    }

    const reset = await git(primary, io, ["reset", "--keep", replayedTip]);
    if (reset.exitCode !== 0) {
      // Roll back the held branch ref — nothing is marked held while the
      // work still sits on the tail.
      await git(repoRoot, io, ["branch", "-D", heldName]);
      return refuse(
        "FLOW-HOLD-07",
        `git reset --keep ${replayedTip.slice(0, 9)} in the primary failed: ${reset.stderr.trim()} — develop is unchanged`,
      );
    }

    const parsed = parseFlowBranch(item.branch ?? "");
    const entry: FlowRegistryEntry = {
      name: heldName,
      kind: parsed?.kind ?? "session",
      base: "develop",
      baseSha: item.base,
      worktree: null,
      owner: { kind: "session", id: `hold-${item.id}` },
      brief: `hold of ${item.branch ?? item.id}`,
      openedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      held: {
        heldAt: now.toISOString(),
        riskCategory: item.category,
        reason,
        tip: item.tip,
      },
      port: null,
    };
    await updateRegistry(io, common, (r) => ({
      ...r,
      branches: [...r.branches.filter((b) => b.name !== heldName), entry],
    }));

    await appendJournal(io, common, {
      event: "hold",
      branch: heldName,
      base: digest.develop.local,
      sha: replayedTip,
      detail: reason,
      rewrites,
    });

    return {
      held: true,
      item: item.id,
      branch: heldName,
      replayedTip,
      rewrites,
      diagnostics: [],
    };
  } finally {
    if (worktreeAdded) {
      await git(repoRoot, io, ["worktree", "remove", "--force", holdWorktree]);
    }
  }
}

function rewritesBase(newCommits: string[], index: number): string {
  return newCommits[index] ?? "";
}

export async function runFlowHold(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowHoldData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io: WorkspaceIO = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.hold must run inside a git repository");
  }

  const item = typeof input.flags["item"] === "string" ? input.flags["item"] : "";
  const reason = typeof input.flags["reason"] === "string" ? input.flags["reason"] : "";
  if (item.length === 0 || reason.length === 0) {
    return {
      data: refuse(
        "FLOW-HOLD-01",
        "--item <id> and --reason <text> are both required",
      ),
      exitCode: 1,
      summary: "[flow.hold] missing required flags",
    };
  }

  const data = await holdFlowItem(repoRoot, io, {
    item,
    reason,
    dryRun: input.flags["dry-run"] === true,
  });
  const errors = data.diagnostics.filter((d) => d.severity === "error");

  if (outputFormat === "pretty") {
    for (const d of data.diagnostics) {
      if (d.severity === "error") logger.error(`  ${d.ruleId}: ${d.message}`);
      else logger.warn(`  ${d.ruleId}: ${d.message}`);
    }
    if (data.held) {
      logger.info(`  held ${data.item} as ${data.branch}`);
      logger.info(`  unhold with: pnpm exec forge flow.unhold --branch ${data.branch}`);
    }
  }

  return {
    data,
    exitCode: errors.length > 0 ? 1 : 0,
    summary: data.held
      ? `[flow.hold] ${data.item} held as ${data.branch}`
      : `[flow.hold] refused — ${errors.length} error(s)`,
  };
}
