/*
<MODULE_CONTRACT>
<purpose>flow.status — the read-only session-branch report (RFC-1487). Lists
every auto branch with its registry entry, worktree, uncommitted-change
count, distance to develop, last commit time, held state and the 72 h stale
flag. collectFlowStatus also feeds flow.check's FLOW-06/07 — one fact source
for both surfaces.</purpose>
<non-goals>
  <item>No mutation — a dead session is named, never reaped here.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The branch set is the union of local auto names and registry entries — a dead session leaves a branch, an entry or a worktree, and each shows up with its mismatch fields set.</item>
  <item>Stale is max(lastCommitAt, updatedAt) &gt; 72 h for registered entries and lastCommitAt &gt; 72 h for unregistered branches; held entries are never stale (RFC FLOW-06).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
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
  <item>RFC-1490: independent-review pass — lock-held planning, fix-branch verification, spec-shaped data, coverage</item>
  <item>RFC-1491: step 1 — journal base/rewrites + held registry widening, W1-1 discard tip, FLOW-INT-11</item>
  <item>RFC-1498: step 1 — FLOW-07 for stray auto branches

collectFlowStatus exposes unregisteredBranchesWithoutWorktree — local auto/* branch names with no registry entry and no worktree checkout anywhere (primary or linked), the shape a failed branch -D leaves behind. flow.check emits one FLOW-07 warning per stray regardless of age: the 72 h rule in FLOW-06 only covered staleness, so a fresh leftover went unreported. The fix hint names flow.status for inspection and flow.discard for teardown, and flags that a branch with unique commits needs a human decision. Tests AC-1 (fresh stray branch reports FLOW-07, not FLOW-06) and AC-2 (a registered session with a live worktree reports none).</item>
  <history>RFC-1487</history>
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
import { parseFlowBranch } from "../branch-name.ts";
import {
  currentBranch,
  git,
  lastCommitAt,
  listLocalBranches,
  requireGit,
  statusDirty,
  statusTracked,
  topLevel,
  worktreeList,
} from "../git.ts";
import {
  commonGitDir,
  FlowRegistrySchemaError,
  readRegistry,
  STALE_AFTER_HOURS,
  type FlowRegistryEntry,
} from "../registry.ts";
import { primaryWorktree } from "../worktree-path.ts";

export interface FlowBranchStatus {
  name: string;
  registered: boolean;
  kind: "session" | "task" | "fix" | null;
  worktree: string | null;
  worktreeExists: boolean;
  /** Tracked-modification count in the worktree; null when no worktree exists. */
  dirty: number | null;
  aheadOfDevelop: number | null;
  behindDevelop: number | null;
  lastCommitAt: string | null;
  stale: boolean;
  /** Held payload (RFC-1491) — the branch is parked, worktree intentionally absent. */
  held: { heldAt: string; riskCategory: string; reason: string; tip: string } | null;
  /** Back-merge port payload when the entry is a port branch (RFC-1490). */
  port: { mainSha: string; tags: string[] } | null;
}

export interface FlowStatusData {
  primary: { path: string; branch: string | null; clean: boolean };
  branches: FlowBranchStatus[];
}

export interface FlowStatusOutcome {
  data: FlowStatusData;
  diagnostics: Diagnostic[];
  /** Registry entries whose branch ref is missing (FLOW-07 material). */
  missingBranchEntries: FlowRegistryEntry[];
  /** Registry entries whose worktree is absent on disk (FLOW-07 material). */
  missingWorktreeEntries: FlowRegistryEntry[];
  /** auto/* worktree paths with no registry entry (FLOW-07 material). */
  unregisteredWorktrees: string[];
  /**
   * RFC-1498: local auto/* branch names with no registry entry and no
   * worktree checkout anywhere — the shape a failed `branch -D` leaves
   * behind. Reported regardless of age (FLOW-06's 72 h rule only covers
   * staleness).
   */
  unregisteredBranchesWithoutWorktree: string[];
  registryError: FlowRegistrySchemaError | null;
}

/**
 * Collect the registry/git/worktree view. `now` is injectable for
 * deterministic stale evaluation. A schema-invalid registry reports
 * `registryError` (FLOW-07 error) and an empty branch list — never rewritten.
 */
export async function collectFlowStatus(
  repoRoot: string,
  io: WorkspaceIO,
  opts?: { now?: Date },
): Promise<FlowStatusOutcome> {
  const now = opts?.now ?? new Date();
  const staleBeforeMs = now.getTime() - STALE_AFTER_HOURS * 3_600_000;

  const diagnostics: Diagnostic[] = [];
  const primary = await primaryWorktree(io, repoRoot);
  const [primaryBranch, primaryDirty, worktrees, local] = await Promise.all([
    currentBranch(primary, io),
    statusTracked(primary, io),
    worktreeList(repoRoot, io),
    listLocalBranches(repoRoot, io),
  ]);

  const common = await commonGitDir(io, repoRoot);
  let entries: FlowRegistryEntry[] = [];
  let registryError: FlowRegistrySchemaError | null = null;
  try {
    entries = (await readRegistry(io, common)).branches;
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) registryError = error;
    else throw error;
  }

  const developExists = (await git(repoRoot, io, ["rev-parse", "--verify", "-q", "refs/heads/develop"])).exitCode === 0;
  const worktreeByBranch = new Map(
    worktrees.filter((w) => w.branch !== null).map((w) => [w.branch as string, w.path]),
  );
  const entryByName = new Map(entries.map((e) => [e.name, e]));

  const autoBranches = local.filter((n) => parseFlowBranch(n) !== null);
  const names = new Set<string>([...autoBranches, ...entries.map((e) => e.name)]);

  const missingBranchEntries: FlowRegistryEntry[] = [];
  const missingWorktreeEntries: FlowRegistryEntry[] = [];
  const unregisteredWorktrees = worktrees
    .filter((w) => w.branch !== null && parseFlowBranch(w.branch) !== null && !entryByName.has(w.branch))
    .filter((w) => w.path !== primary)
    .map((w) => w.path);

  // RFC-1498: a stray is a local auto branch nothing owns — no registry
  // entry and no worktree (primary or linked) checks it out.
  const unregisteredBranchesWithoutWorktree = autoBranches
    .filter((name) => !entryByName.has(name) && !worktreeByBranch.has(name))
    .sort();

  const branches: FlowBranchStatus[] = [];
  for (const name of [...names].sort()) {
    const entry = entryByName.get(name);
    const branchRefExists = autoBranches.includes(name);
    const worktree = worktreeByBranch.get(name) ?? entry?.worktree ?? null;
    const worktreeExists = worktree !== null && (await io.exists(worktree));

    if (entry && !branchRefExists) missingBranchEntries.push(entry);
    // A held entry's null worktree is its expected state — never a FLOW-07
    // disagreement (AUDIT-RFC-1491-C1). Held-with-worktree or unheld-without
    // is rejected by the registry schema, surfacing as registryError.
    if (entry && !worktreeExists && entry.held === null) missingWorktreeEntries.push(entry);

    const last = branchRefExists ? await lastCommitAt(repoRoot, io, name) : null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (branchRefExists && developExists) {
      const counts = await git(repoRoot, io, [
        "rev-list",
        "--left-right",
        "--count",
        `develop...${name}`,
      ]);
      const [behindStr, aheadStr] = counts.stdout.trim().split(/\s+/);
      behind = Number(behindStr) || 0;
      ahead = Number(aheadStr) || 0;
    }
    const dirty = worktreeExists ? (await statusDirty(worktree, io)).length : null;

    const held = entry?.held ?? null;
    let stale = false;
    if (held === null) {
      if (entry) {
        const newest = [last, entry.updatedAt]
          .filter((t): t is string => t !== null)
          .map((t) => Date.parse(t))
          .reduce((a, b) => Math.max(a, b), 0);
        stale = newest > 0 && newest < staleBeforeMs;
      } else if (last !== null) {
        stale = Date.parse(last) < staleBeforeMs;
      }
    }

    branches.push({
      name,
      registered: entry !== undefined,
      kind: entry?.kind ?? parseFlowBranch(name)?.kind ?? null,
      worktree,
      worktreeExists,
      dirty,
      aheadOfDevelop: ahead,
      behindDevelop: behind,
      lastCommitAt: last,
      stale,
      held,
      port: entry?.port ?? null,
    });
  }

  return {
    data: {
      primary: { path: primary, branch: primaryBranch, clean: primaryDirty.length === 0 },
      branches,
    },
    diagnostics,
    missingBranchEntries,
    missingWorktreeEntries,
    unregisteredWorktrees,
    unregisteredBranchesWithoutWorktree,
    registryError,
  };
}

export async function runFlowStatus(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowStatusData & { diagnostics: Diagnostic[] }>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.status must run inside a git repository");
  }

  const outcome = await collectFlowStatus(repoRoot, io);
  if (outcome.registryError) {
    outcome.diagnostics.push({
      ruleId: "FLOW-07",
      severity: "error",
      message: outcome.registryError.message,
      fixHint: `repair or remove ${outcome.registryError.file}`,
    });
  }

  if (outputFormat === "pretty") {
    logger.section("flow.status");
    logger.info(
      `  primary: ${outcome.data.primary.path} on ${outcome.data.primary.branch ?? "detached"} (${outcome.data.primary.clean ? "clean" : "dirty"})`,
    );
    for (const b of outcome.data.branches) {
      logger.info(
        b.held !== null
          ? `  ${b.name}: held (${b.held.riskCategory}): ${b.held.reason}`
          : `  ${b.name}: ${b.registered ? "registered" : "unregistered"}, worktree ${b.worktreeExists ? "present" : "absent"}, dirty ${b.dirty ?? "-"}, +${b.aheadOfDevelop ?? "-"}/-${b.behindDevelop ?? "-"}, stale ${b.stale}`,
      );
    }
    for (const d of outcome.diagnostics) {
      logger.error(`  ${d.ruleId}: ${d.message}`);
    }
  }

  return {
    data: { ...outcome.data, diagnostics: outcome.diagnostics },
    exitCode: outcome.diagnostics.some((d) => d.severity === "error") ? 1 : 0,
    summary: `[flow.status] ${outcome.data.branches.length} auto branch(es), ${outcome.data.branches.filter((b) => b.stale).length} stale`,
  };
}
