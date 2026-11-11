/*
<MODULE_CONTRACT>
<purpose>flow.open — open a session or task branch in its own worktree
(RFC-1487). Assigns the next free NN for today's UTC date across local
branches, remote-tracking refs and the registry, creates
auto/&lt;kind&gt;-&lt;YYMMDD&gt;-&lt;NN&gt;-&lt;slug&gt; from the tip of
develop in &lt;parent&gt;/&lt;repo&gt;@&lt;branch-slug&gt;, records the
registry entry, journals the open, then runs the primary's optional
hooks/worktree-setup.sh.</purpose>
<non-goals>
  <item>No activation — repositories opt in via flow.install; the wave-4 switch-over wires sessions to this command.</item>
  <item>No task dispatch — --kind task records an --owner id; no queue consumes it yet.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>NN is kind-agnostic: the highest NN for today's date across every auto name source — the daily sequence stays unique regardless of kind (RFC literal).</item>
  <item>Branch-name collisions on `worktree add -b` retry with the next NN at most 3 times — the NN race between parallel opens resolves without a lock held across git calls.</item>
  <item>A failed setup script is reported, never rolled back — the worktree and registry entry stay, and the command exits 1 (DNA-106).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>ADR-0124: enable git rerere in flow-managed repositories</item>
  <item>RFC-1536: owning-checkout routing, FLOW-OPEN-01 dirty-primary warning, shared governance-id allocation (RFC+ADR)</item>
  <item>RFC-1536: evidence — routing/warning tests, FLOW-OPEN-10 validation renumber, owning-worktree doc rule, frictions F-0091/F-0096/F-0106/F-0119 addressed</item>
  <item>RFC-1533: pending-branch summary + primaryMutations on the result; FLOW-OPEN-02 freed for the registry-unreadable warning (refusal renumbered to FLOW-OPEN-11)</item>
  <item>ADR-0129: F-0186/F-0187 — FLOW-INT-03 names paths + three-way remedy, FLOW-OPEN-01 same hint, forge CLI kernel-command hint</item>
  <history>RFC-1487, RFC-1490</history>
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
  ensureRerere,
  git,
  listLocalBranches,
  listRemoteBranches,
  requireGit,
  statusTracked,
  topLevel,
} from "../git.ts";
import { formatFlowBranch, parseFlowBranch, type FlowBranchKind } from "../branch-name.ts";
import { FOREIGN_PRIMARY_DIRT_HINT } from "../dirty-classify.ts";
import { LockTimeoutError } from "../locks.ts";
import { detectRepoKind } from "../repo-kind.ts";
import {
  appendJournal,
  commonGitDir,
  FlowRegistrySchemaError,
  readRegistry,
  registryPath,
  updateRegistry,
  type FlowRegistryEntry,
} from "../registry.ts";
import { runFlowScript, type FlowScriptResult } from "../scripts.ts";
import { collectFlowStatus } from "./flow-status.ts";
import { flowWorktreePath, primaryWorktree } from "../worktree-path.ts";

const OPEN_MAX_ATTEMPTS = 3;

export interface FlowOpenOptions {
  /** Raw --kind value; validated to session|task before anything else. */
  kind: string;
  slug: string;
  brief: string | null;
  /** Required for task; sessions default to "unspecified" (AUDIT C2). */
  owner: string | null;
  dryRun: boolean;
  /** Injected clock — NN dates and registry timestamps (never Date.now inside). */
  now?: Date;
}

/** Injectable open core (RFC-1490) — flow.cut/fix call this directly. */
export interface FlowOpenCoreOptions {
  kind: FlowBranchKind;
  slug: string;
  brief: string | null;
  /** Registry owner — session/task kind plus an id (e.g. `release`, operator session). */
  owner: { kind: "session" | "task"; id: string };
  dryRun: boolean;
  now?: Date;
  /** Registry base — task/session open on develop, fix on main. */
  base?: "develop" | "main";
  /** Ref the worktree branches from — defaults to the base. */
  baseRef?: string;
  /** Back-merge port payload (RFC-1490) — non-null only on port branches. */
  port?: { mainSha: string; tags: string[] };
  /** Journal event for the open — "open" normally, "fix" for flow.fix. */
  journalEvent?: "open" | "fix";
}

export interface FlowOpenData {
  repoKind: "governed";
  branch: string | null;
  worktree: string | null;
  base: "develop" | "main";
  baseSha: string | null;
  opened: boolean;
  setup: FlowScriptResult | null;
  /** RFC-1533: tracked-dirty paths in the primary at open time (the sweep's
   * input — empty when clean or already refused before the status read). */
  primaryMutations: string[];
  /** RFC-1533: registered siblings excluding the branch just opened;
   * null when the registry could not be read for the summary (FLOW-OPEN-02). */
  pending: {
    total: number;
    byKind: { session: number; task: number; fix: number };
    stale: number;
  } | null;
  diagnostics: Diagnostic[];
}

function refuse(ruleId: string, message: string, fixHint: string): FlowOpenData {
  return {
    repoKind: "governed",
    branch: null,
    worktree: null,
    base: "develop",
    baseSha: null,
    opened: false,
    setup: null,
    primaryMutations: [],
    pending: null,
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Highest NN for `date` among candidate auto branch names; returns max+1. */
export function nextFlowSeq(names: string[], yymmdd: string): number {
  let max = 0;
  for (const raw of names) {
    const parsed = parseFlowBranch(raw);
    if (parsed && parsed.date === yymmdd) max = Math.max(max, parsed.seq);
  }
  return max + 1;
}

/**
 * Core of flow.open — callable with an injected clock; every refusal path is
 * a diagnostic in the returned data, nothing mutates unless opened: true.
 */
export async function openFlowBranch(
  repoRoot: string,
  io: WorkspaceIO,
  opts: FlowOpenOptions,
): Promise<FlowOpenData> {
  // Flags — FLOW-OPEN-10/05 first, before any git fact is consulted.
  if (opts.kind !== "session" && opts.kind !== "task") {
    return refuse(
      "FLOW-OPEN-10",
      `invalid --kind '${opts.kind}'`,
      "use --kind session or --kind task",
    );
  }
  if (opts.kind === "task" && (opts.owner === null || opts.owner === "")) {
    return refuse(
      "FLOW-OPEN-05",
      "--kind task requires --owner <task-id>",
      "pass the queue task id via --owner, or use --kind session",
    );
  }
  return openFlowBranchCore(repoRoot, io, {
    kind: opts.kind,
    slug: opts.slug,
    brief: opts.brief,
    owner: { kind: opts.kind, id: opts.owner ?? "unspecified" },
    dryRun: opts.dryRun,
    now: opts.now,
  });
}

/**
 * Open core — every refusal path is a diagnostic in the returned data,
 * nothing mutates unless opened: true. flow.cut calls it with
 * kind `session`, owner `{kind: "session", id: "release"}`.
 */
export async function openFlowBranchCore(
  repoRoot: string,
  io: WorkspaceIO,
  opts: FlowOpenCoreOptions,
): Promise<FlowOpenData> {
  const now = opts.now ?? new Date();
  const base = opts.base ?? "develop";
  const baseRef = opts.baseRef ?? base;

  if (!SLUG_RE.test(opts.slug) || opts.slug.length < 3 || opts.slug.length > 48) {
    return refuse(
      "FLOW-OPEN-10",
      `invalid --slug '${opts.slug}'`,
      "slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be 3..48 characters",
    );
  }

  // Governed repository only — the fixed model's guard is what makes the
  // branch meaningful.
  const detection = await detectRepoKind(repoRoot, io);
  if (!detection.ok) {
    return refuse(
      "FLOW-OPEN-06",
      `${detection.detail} — flow.open only opens branches in governed repositories`,
      "fix forge.generated.yaml or remove the marker before opening a session",
    );
  }
  if (detection.repoKind.kind !== "governed") {
    return refuse(
      "FLOW-OPEN-06",
      `repository is ${detection.repoKind.kind}, not governed`,
      "adopt the fixed branch model with flow.install before flow.open",
    );
  }

  if (!(await branchExists(repoRoot, io, baseRef))) {
    return refuse(
      "FLOW-OPEN-11",
      `local branch ${baseRef} does not exist`,
      base === "develop"
        ? "adopt the fixed branch model with flow.install first"
        : "cut a release first — flow.fix opens from the main tip",
    );
  }
  const baseShaResult = await git(repoRoot, io, ["rev-parse", `refs/heads/${baseRef}`]);
  const baseSha = baseShaResult.stdout.trim();

  const primary = await primaryWorktree(io, repoRoot);
  const common = await commonGitDir(io, repoRoot);

  // RFC-1536/RFC-1533 FLOW-OPEN-01: warn when the primary checkout carries
  // tracked mutations — the sweep does NOT move them into the worktree.
  // Warning severity, exit code unchanged; the same diagnostic fires at
  // flow.check so the condition is visible between opens.
  const dirtyPrimaryDiags: Diagnostic[] = [];
  let primaryMutations: string[] = [];
  {
    const primaryStatus = await statusTracked(primary, io);
    if (!primaryStatus.vanished) {
      primaryMutations = primaryStatus.entries.map((e) => e.slice(3));
    }
    if (primaryMutations.length > 0) {
      const shown = primaryMutations.slice(0, 10);
      dirtyPrimaryDiags.push({
        ruleId: "FLOW-OPEN-01",
        severity: "warning",
        message:
          `primary checkout carries ${primaryMutations.length} tracked mutation(s): ${shown.join(", ")}` +
          (primaryMutations.length > shown.length
            ? ` (+${primaryMutations.length - shown.length} more)`
            : "") +
          " — they are NOT swept into the worktree; commit or move them first",
        fixHint: FOREIGN_PRIMARY_DIRT_HINT,
      });
    }
  }

  // Candidate names — local branches, remote-tracking auto refs, registry.
  let registryNames: string[];
  try {
    const registry = await readRegistry(io, common);
    registryNames = registry.branches.map((b) => b.name);
  } catch (error) {
    if (error instanceof FlowRegistrySchemaError) {
      return refuse(
        "FLOW-07",
        error.message,
        `repair or remove ${registryPath(common)} — every flow command reads it`,
      );
    }
    throw error;
  }
  const [local, remote] = await Promise.all([
    listLocalBranches(repoRoot, io),
    listRemoteBranches(repoRoot, io),
  ]);
  // Remote-tracking shorts are `<remote>/<branch>` — strip the remote segment
  // so parseFlowBranch sees the auto name.
  const remoteNames = remote.map((r) => r.slice(r.indexOf("/") + 1));
  const candidates = [...local, ...remoteNames, ...registryNames];

  const yy = String(now.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const today = `${yy}${mm}${dd}`;

  let seq = nextFlowSeq(candidates, today);
  if (seq > 99) {
    return refuse(
      "FLOW-OPEN-04",
      `no free NN for ${today} — 99 branches already opened today`,
      "discard stale auto branches with flow.discard and re-run tomorrow",
    );
  }

  const ownerId = opts.owner.id;
  const iso = now.toISOString();

  // ADR-0124: repair shared rerere config idempotently at worktree setup —
  // a repo adopted before ADR-0124 self-heals on the next session open.
  // Never blocks: a config write failure is a warning, not a refusal.
  const rerereDiags: Diagnostic[] = [];
  if (!opts.dryRun) {
    for (const failure of await ensureRerere(repoRoot, io)) {
      rerereDiags.push({
        ruleId: "FLOW-OPEN-08",
        severity: "warning",
        message: `rerere config repair failed: ${failure}`,
        fixHint: `run git config rerere.enabled true && git config rerere.autoupdate true in ${repoRoot}`,
      });
    }
  }

  // RFC-1533 pending summary — registered siblings excluding the branch just
  // opened, computed through collectFlowStatus (single fact source). A
  // registry read failure degrades to `pending: null` + FLOW-OPEN-02 warning;
  // surfacing must never wedge worktree creation.
  const pendingSummary = async (
    excludeName: string,
  ): Promise<{ pending: FlowOpenData["pending"]; diags: Diagnostic[] }> => {
    const unreadable = {
      pending: null,
      diags: [
        {
          ruleId: "FLOW-OPEN-02" as const,
          severity: "warning" as const,
          message: "flow registry absent or unreadable — pending-branch summary unavailable",
          fixHint: `run flow.check for registry diagnostics; repair or remove ${registryPath(common)}`,
        },
      ],
    };
    try {
      // On the success path the registry always exists (registration wrote
      // it) — the absent branch is reachable on a dry-run over a repo that
      // never opened a flow branch.
      if (!(await io.exists(registryPath(common)))) return unreadable;
      const status = await collectFlowStatus(repoRoot, io, { now });
      if (status.registryError) throw status.registryError;
      const siblings = status.data.branches.filter((b) => b.registered && b.name !== excludeName);
      return {
        pending: {
          total: siblings.length,
          byKind: {
            session: siblings.filter((b) => b.kind === "session").length,
            task: siblings.filter((b) => b.kind === "task").length,
            fix: siblings.filter((b) => b.kind === "fix").length,
          },
          stale: siblings.filter((b) => b.stale).length,
        },
        diags: [],
      };
    } catch {
      return unreadable;
    }
  };

  for (let attempt = 1; attempt <= OPEN_MAX_ATTEMPTS; attempt++) {
    const name = formatFlowBranch({
      kind: opts.kind as FlowBranchKind,
      date: now,
      seq,
      slug: opts.slug,
    });
    // candidates gains each tried name so a collision retry picks the next NN.
    const worktree = flowWorktreePath(primary, name);

    if (await io.exists(worktree)) {
      return refuse(
        "FLOW-OPEN-03",
        `target worktree path ${worktree} already exists`,
        "remove the stale directory or pick a different --slug",
      );
    }

    if (opts.dryRun) {
      const pending = await pendingSummary(name);
      return {
        repoKind: "governed",
        branch: name,
        worktree,
        base,
        baseSha,
        opened: false,
        setup: { status: "skipped", exitCode: null, stderrTail: "", stdout: "" },
        primaryMutations,
        pending: pending.pending,
        diagnostics: [...dirtyPrimaryDiags, ...pending.diags],
      };
    }

    const add = await git(primary, io, ["worktree", "add", "-b", name, worktree, baseRef]);
    if (add.exitCode !== 0) {
      const collision =
        add.stderr.includes("already exists") || add.stderr.includes("is already used");
      if (collision) {
        if (attempt < OPEN_MAX_ATTEMPTS) {
          seq = nextFlowSeq([...candidates, name], today);
          if (seq > 99) {
            return refuse(
              "FLOW-OPEN-04",
              `no free NN for ${today} — 99 branches already opened today`,
              "discard stale auto branches with flow.discard and re-run tomorrow",
            );
          }
          continue;
        }
        return refuse(
          "FLOW-OPEN-04",
          `branch name still collides after ${OPEN_MAX_ATTEMPTS} attempts (${name})`,
          "a parallel flow.open is racing — re-run, or inspect refs/heads/auto/*",
        );
      }
      return refuse(
        "FLOW-OPEN-09",
        `git worktree add -b ${name} failed (exit ${add.exitCode}): ${add.stderr.trim()}`,
        "inspect the git error — a stale ref or lock may need cleanup",
      );
    }

    const entry: FlowRegistryEntry = {
      name,
      kind: opts.kind,
      base,
      baseSha,
      worktree,
      owner: opts.owner,
      brief: opts.brief,
      openedAt: iso,
      updatedAt: iso,
      held: null,
      port: opts.port ?? null,
    };
    try {
      await updateRegistry(io, common, (r) => ({
        ...r,
        branches: [...r.branches.filter((b) => b.name !== name), entry],
      }));
      await appendJournal(io, common, {
        at: iso,
        event: opts.journalEvent ?? "open",
        branch: name,
        sha: baseSha,
        detail: opts.brief ?? `${opts.kind} opened by ${ownerId}`,
      });
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        return refuse(
          "FLOW-07",
          `registry lock ${error.lockPath} still held after 10 s`,
          "a live flow command holds the lock — retry, or remove the lock if the holder died",
        );
      }
      if (error instanceof FlowRegistrySchemaError) {
        return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`);
      }
      throw error;
    }

    const setup = await runFlowScript(io, "worktree-setup", {
      primary,
      cwd: worktree,
      env: { FLOW_PRIMARY: primary, FLOW_BRANCH: name },
    });
    const setupDiag: Diagnostic[] =
      setup.status === "failed"
        ? [
            {
              ruleId: "FLOW-OPEN-07",
              severity: "error",
              message: `hooks/worktree-setup.sh failed (exit ${setup.exitCode}): ${setup.stderrTail}`,
              fixHint: `fix ${primary}/hooks/worktree-setup.sh — the worktree ${worktree} and its registry entry are kept`,
            },
          ]
        : [];

    const pending = await pendingSummary(name);
    return {
      repoKind: "governed",
      branch: name,
      worktree,
      base,
      baseSha,
      opened: true,
      setup,
      primaryMutations,
      pending: pending.pending,
      diagnostics: [...dirtyPrimaryDiags, ...pending.diags, ...rerereDiags, ...setupDiag],
    };
  }
  return refuse(
    "FLOW-OPEN-04",
    `branch name still collides after ${OPEN_MAX_ATTEMPTS} attempts`,
    "a parallel flow.open is racing — retry, or inspect refs/heads/auto/*",
  );
}

export async function runFlowOpen(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowOpenData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.open must run inside a git repository");
  }

  const flag = (name: string): string | null => {
    const v = input.flags[name];
    return typeof v === "string" ? v : null;
  };
  const data = await openFlowBranch(repoRoot, io, {
    kind: flag("kind") ?? "",
    slug: flag("slug") ?? "",
    brief: flag("brief"),
    owner: flag("owner"),
    dryRun: context.dryRun || input.flags["dry-run"] === true,
  });

  const refused = data.diagnostics.find((d) => d.severity === "error");
  if (outputFormat === "pretty") {
    if (refused) {
      logger.error(`flow.open refused: ${refused.message}`);
    } else {
      logger.section("flow.open");
      logger.info(`  branch:   ${data.branch}`);
      logger.info(`  worktree: ${data.worktree}`);
      logger.info(`  base:     ${data.base} @ ${data.baseSha?.slice(0, 9)}`);
      logger.info(`  setup:    ${data.setup?.status ?? "skipped"}`);
      for (const d of data.diagnostics) {
        if (d.severity === "error") logger.error(`  ${d.ruleId}: ${d.message}`);
        else logger.warn(`  ${d.ruleId}: ${d.message}`);
      }
      if (data.pending !== null && data.pending.total > 0) {
        logger.info(
          `  pending: ${data.pending.total} registered branch(es) — ` +
            `${data.pending.stale} stale (>72h); inspect with flow.status`,
        );
      }
    }
  }

  return {
    data,
    exitCode: refused ? 1 : 0,
    summary: refused
      ? `[flow.open] refused: ${refused.ruleId} ${refused.message}`
      : `[flow.open] opened ${data.branch} in ${data.worktree} (setup ${data.setup?.status ?? "skipped"})`,
    nextSteps: refused
      ? []
      : [
          {
            action: `continue your work inside ${data.worktree} — run flow.integrate from there when done`,
            kind: "required",
          },
        ],
  };
}
