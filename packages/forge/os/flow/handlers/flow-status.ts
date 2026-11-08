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
  <item>Stray (RFC-1498): a local auto branch with no registry entry and no worktree checkout anywhere is exposed as unregisteredBranchesWithoutWorktree regardless of age — the leftover shape a failed branch -D leaves.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: independent-review pass — lock-held planning, fix-branch verification, spec-shaped data, coverage</item>
  <item>RFC-1491: step 1 — journal base/rewrites + held registry widening, W1-1 discard tip, FLOW-INT-11</item>
  <item>RFC-1498: step 1 — FLOW-07 for stray auto branches

collectFlowStatus exposes unregisteredBranchesWithoutWorktree — local auto/* branch names with no registry entry and no worktree checkout anywhere (primary or linked), the shape a failed branch -D leaves behind. flow.check emits one FLOW-07 warning per stray regardless of age: the 72 h rule in FLOW-06 only covered staleness, so a fresh leftover went unreported. The fix hint names flow.status for inspection and flow.discard for teardown, and flags that a branch with unique commits needs a human decision. Tests AC-1 (fresh stray branch reports FLOW-07, not FLOW-06) and AC-2 (a registered session with a live worktree reports none).</item>
  <item>RFC-1498: step 2 — network-only marker source

markerSource accepts only network-shaped origins — http/https/ssh/git schemes or the scp user-at-host form — and returns { source, rejectedOrigin }. A local path or file:// URL falls back to the repository directory basename with rejectedOrigin naming the kind (local-path or file-url), so no machine-local path is ever written into an extract repository marker; embedded credentials are still stripped from network URLs. flow.install resolves the source at plan time, stores it on the plan for the execute phase, and the markers step warns origin rejected (kind) — using the directory name, never printing the path. Tests AC-3 (local path and file:// rejected, basename used, path absent from the step detail) and AC-4 (scp URL kept verbatim, https credentials stripped). Also carries the KEY_DECISIONS compass notes for step 1's stray-branch rule.</item>
  <item>RFC-1515: harden forge flow worktree lifecycle against vanished paths, forge-local state, dead-holder locks and generated drift</item>
  <item>RFC-1537: branches[].lastRefusal + derived orphaned flag — the newest integrate-refusal journal event per branch is the discoverable escape path after a refused flow.integrate</item>
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
  readJournal,
  readRegistry,
  STALE_AFTER_HOURS,
  type FlowJournalEvent,
  type FlowRegistryEntry,
} from "../registry.ts";
import { primaryWorktree } from "../worktree-path.ts";

export interface FlowBranchStatus {
  name: string;
  registered: boolean;
  kind: "session" | "task" | "fix" | null;
  worktree: string | null;
  worktreeExists: boolean;
  /** RFC-1515: a registered worktree path that is gone from disk — distinct
   * from a null worktree (held entries legitimately have none). */
  vanished: boolean;
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
  /** RFC-1537: newest journaled integrate refusal for this branch — the
   * discoverable escape path after a refused flow.integrate. */
  lastRefusal: { rule: string | null; at: string; summary: string } | null;
  /** RFC-1537: the branch's newest journal event is an integrate refusal
   * while the branch still exists — nothing reclaimed it since. */
  orphaned: boolean;
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
  const [primaryBranch, primaryStatus, worktrees, local] = await Promise.all([
    currentBranch(primary, io),
    statusTracked(primary, io),
    worktreeList(repoRoot, io),
    listLocalBranches(repoRoot, io),
  ]);
  const primaryDirty = primaryStatus.entries;

  const common = await commonGitDir(io, repoRoot);
  // RFC-1537: journal is read-only here — a corrupt or unreadable journal
  // degrades lastRefusal/orphaned to absent, never breaks status.
  let journal: FlowJournalEvent[] = [];
  try {
    journal = await readJournal(io, common);
  } catch {
    journal = [];
  }
  // Append order keeps the newest event last — the last hit per branch wins.
  const lastEventByBranch = new Map<string, FlowJournalEvent>();
  const lastRefusalByBranch = new Map<string, FlowJournalEvent>();
  for (const e of journal) {
    lastEventByBranch.set(e.branch, e);
    if (e.event === "integrate-refusal") lastRefusalByBranch.set(e.branch, e);
  }
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
    const dirty = worktreeExists ? (await statusDirty(worktree, io)).entries.length : null;

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
      vanished: worktree !== null && !worktreeExists,
      dirty,
      aheadOfDevelop: ahead,
      behindDevelop: behind,
      lastCommitAt: last,
      stale,
      held,
      port: entry?.port ?? null,
      lastRefusal: (() => {
        const r = lastRefusalByBranch.get(name);
        return r === undefined
          ? null
          : { rule: r.rule ?? null, at: r.at, summary: r.detail };
      })(),
      orphaned: lastEventByBranch.get(name)?.event === "integrate-refusal",
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
          : `  ${b.name}: ${b.registered ? "registered" : "unregistered"}, worktree ${b.worktreeExists ? "present" : b.vanished ? "vanished" : "absent"}, dirty ${b.dirty ?? "-"}, +${b.aheadOfDevelop ?? "-"}/-${b.behindDevelop ?? "-"}, stale ${b.stale}`,
      );
      if (b.orphaned && b.lastRefusal !== null) {
        logger.info(
          `    └─ last integrate refused (${b.lastRefusal.rule ?? "unknown"}) at ${b.lastRefusal.at}: ${b.lastRefusal.summary}`,
        );
      }
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
