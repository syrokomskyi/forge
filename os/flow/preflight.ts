/*
<MODULE_CONTRACT>
<purpose>flow.integrate preflight (RFC-1528) — a bounded, deterministic check list that
runs between the dirty-tree checks and the integration-gate spawn, refusing in
seconds what the gate would catch minutes later. Ordered: (1) worktree dirty +
lockfile-diff classification, (2) primary tracked dirt + classification,
(3) ecosystem.manifest.validate, (4) rfc.validate --id per changed RFC file,
(5) friction.validate. Each check runs only when resolvable (invoke port +
registry entry) — absence degrades with a note, never blocks. The list is
closed by the RFC: adding a check requires an amendment.</purpose>
<non-goals>
  <item>No auto-fix, no auto-commit — the lockfile classifier only labels the importer-prune-only shape with a remedy hint; a dirty pnpm-lock.yaml still refuses.</item>
  <item>No builds, no test suites — sub-minute deterministic validators only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1528: initial — classifyLockfileDiff + runIntegratePreflight (FLOW-INT-01/03 classification, FLOW-INT-12/13/14 validator refusals).</item>
  <item>RFC-1528: flow.integrate bounded preflight before rebase and gate

Classified lockfile diffs on FLOW-INT-01/03, early primary check, and resolvable validators (ecosystem.manifest.validate, scoped rfc.validate, friction.validate) refusing as FLOW-INT-12/13/14.</item>
  <item>RFC-1528: close review findings — manifest-union command inventory for regen/preflight</item>
</CHANGE_SUMMARY>
*/

import type {
  CommandRegistry,
  ForgeInvokeCommand,
  ForgeRegisteredCommandInfo,
  WorkspaceIO,
} from "../../src/types.ts";
import { loadLiveCommandInventory } from "../../src/utils/command-inventory.ts";
import { currentBranch, git, statusTracked } from "./git.ts";

export type LockfileClassification = "importer-prune-only" | "other";

/**
 * Strict match for the pnpm-prune shape: ONLY removed lines, every one either
 * a `missions/<id>/workpiece:` importer key or a deeper-indented member of
 * such a key's block. Any added line, any other removed line, or a diff with
 * no removals classifies "other" — ambiguous diffs stay ordinary refusals.
 */
export function classifyLockfileDiff(diffText: string): LockfileClassification {
  let sawImporterKey = false;
  let openBlockIndent: number | null = null;
  for (const raw of diffText.split("\n")) {
    if (
      raw === "" ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@")
    ) {
      if (raw.startsWith("@@")) openBlockIndent = null;
      continue;
    }
    if (raw.startsWith("+")) return "other";
    const line = raw.slice(1);
    if (raw[0] === " ") {
      const indent = line.length - line.trimStart().length;
      if (openBlockIndent !== null && line.trim().length > 0 && indent <= openBlockIndent) {
        openBlockIndent = null;
      }
      continue;
    }
    if (raw[0] !== "-") continue;
    if (line.trim().length === 0) {
      // A blank removed line only tolerates inside an open importer block.
      if (openBlockIndent === null) return "other";
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (/^\s*missions\/[^\s/]+\/workpiece:\s*$/.test(line)) {
      sawImporterKey = true;
      openBlockIndent = indent;
      continue;
    }
    if (openBlockIndent !== null && indent > openBlockIndent) continue;
    return "other";
  }
  return sawImporterKey ? "importer-prune-only" : "other";
}

/** Classify the pnpm-lock.yaml diff of `repo` when the lockfile is dirty. */
async function classifyDirtyLockfile(
  repo: string,
  io: WorkspaceIO,
  dirtyEntries: string[],
  runGit: typeof git,
): Promise<LockfileClassification | null> {
  const lockfileDirty = dirtyEntries.some((entry) => entry.slice(3).trim() === "pnpm-lock.yaml");
  if (!lockfileDirty) return null;
  const diff = await runGit(repo, io, ["diff", "HEAD", "--", "pnpm-lock.yaml"]);
  return classifyLockfileDiff(diff.stdout);
}

const LOCKFILE_PRUNE_HINT =
  " — its diff matches the vanished mission-importer prune shape; restore it " +
  "(`git checkout -- pnpm-lock.yaml` is blocked for agents: copy HEAD bytes " +
  "with `git show HEAD:pnpm-lock.yaml > pnpm-lock.yaml`) or commit the prune deliberately";

export interface PreflightRefuse {
  ruleId: string;
  message: string;
  fixHint: string;
  data?: Record<string, unknown>;
}

export interface PreflightSkip {
  check: string;
  reason: "no-invoke" | "unresolvable";
}

export interface IntegratePreflightResult {
  ok: boolean;
  /** Check names that ran, in order. */
  checked: string[];
  /** Checks skipped — invoke port absent, or command not in the inventory. */
  skipped: PreflightSkip[];
  refuse?: PreflightRefuse;
}

/**
 * The bounded preflight — first failure wins. `deps` seams exist for tests;
 * production passes the real git helpers.
 */
export async function runIntegratePreflight(
  opts: {
    primary: string;
    branchWorktree: string;
    branch: string;
    io: WorkspaceIO;
    /** Already-computed statusDirty() of the branch worktree. */
    worktreeDirty: { entries: string[]; toleratedState: string[] };
    invoke?: ForgeInvokeCommand;
    commandRegistry?: CommandRegistry;
    /** Test seam — overrides the live inventory union (registry + command manifest). */
    commands?: ForgeRegisteredCommandInfo[];
  },
  deps: {
    runGit: typeof git;
    runStatusTracked: typeof statusTracked;
    runCurrentBranch: typeof currentBranch;
  } = { runGit: git, runStatusTracked: statusTracked, runCurrentBranch: currentBranch },
): Promise<IntegratePreflightResult> {
  const checked: string[] = [];
  const skipped: PreflightSkip[] = [];
  const { io } = opts;
  // D-001 union: werkstatt run supplies invoke but no commandRegistry — the
  // generated manifest (in the primary checkout) covers resolvability.
  const commands = opts.commands ?? loadLiveCommandInventory(opts.primary, opts.commandRegistry);
  const commandNames = new Set(commands.map((c) => c.name));
  const resolvable = (name: string) => opts.invoke !== undefined && commandNames.has(name);

  // (1) worktree dirty — FLOW-INT-01 with lockfile classification.
  checked.push("worktree-dirty");
  if (opts.worktreeDirty.entries.length > 0) {
    const lockfile = await classifyDirtyLockfile(
      opts.branchWorktree,
      io,
      opts.worktreeDirty.entries,
      deps.runGit,
    );
    return {
      ok: false,
      checked,
      skipped,
      refuse: {
        ruleId: "FLOW-INT-01",
        message:
          `worktree ${opts.branchWorktree} has ${opts.worktreeDirty.entries.length} uncommitted change(s): ${opts.worktreeDirty.entries.slice(0, 10).join(", ")}` +
          (opts.worktreeDirty.toleratedState.length > 0
            ? ` — tolerated forge-local state: ${opts.worktreeDirty.toleratedState.join(", ")}`
            : "") +
          (lockfile === "importer-prune-only" ? ` — pnpm-lock.yaml${LOCKFILE_PRUNE_HINT}` : ""),
        fixHint:
          "commit or revert the uncommitted changes inside the session worktree, then re-run",
        data: {
          entries: opts.worktreeDirty.entries.map((line) => line.slice(3)),
          toleratedState: opts.worktreeDirty.toleratedState,
          ...(lockfile !== null ? { lockfileClassification: lockfile } : {}),
        },
      },
    };
  }

  // (2) primary must sit clean on develop — early FLOW-INT-03, same
  // classification; the post-gate check stays (primary can dirty mid-gate).
  checked.push("primary-dirty");
  const primaryBranch = await deps.runCurrentBranch(opts.primary, io);
  const primaryDirty = await deps.runStatusTracked(opts.primary, io);
  if (primaryBranch !== "develop" || primaryDirty.entries.length > 0) {
    const lockfile = await classifyDirtyLockfile(
      opts.primary,
      io,
      primaryDirty.entries,
      deps.runGit,
    );
    return {
      ok: false,
      checked,
      skipped,
      refuse: {
        ruleId: "FLOW-INT-03",
        message:
          (primaryBranch !== "develop"
            ? `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`
            : `primary worktree has ${primaryDirty.entries.length} uncommitted change(s)`) +
          (lockfile === "importer-prune-only" ? ` — pnpm-lock.yaml${LOCKFILE_PRUNE_HINT}` : ""),
        fixHint:
          "switch the primary to develop and commit or revert its tracked changes, then re-run — the branch stays rebased",
        data: {
          entries: primaryDirty.entries.map((line) => line.slice(3)),
          ...(lockfile !== null ? { lockfileClassification: lockfile } : {}),
        },
      },
    };
  }

  // (3) ecosystem.manifest.validate — stale generated manifest refuses early.
  if (resolvable("ecosystem.manifest.validate")) {
    checked.push("ecosystem.manifest.validate");
    const result = await opts.invoke!("ecosystem.manifest.validate", {});
    if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
      return {
        ok: false,
        checked,
        skipped,
        refuse: {
          ruleId: "FLOW-INT-12",
          message: `preflight: ecosystem.manifest.validate refused — ${result.summary ?? `exit ${result.exitCode}`}`,
          fixHint:
            "regenerate the manifest via `pnpm exec werkstatt run ecosystem.manifest.generate`, commit, then re-run flow.integrate",
          data: { command: "ecosystem.manifest.validate", summary: result.summary },
        },
      };
    }
  } else {
    skipped.push({
      check: "ecosystem.manifest.validate",
      reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
    });
  }

  // (4) rfc.validate --id per changed RFC file on develop...branch.
  // --diff-filter=d excludes deletions — an archive move's old path must not
  // produce a validate-id on a vanished file.
  const diff = await deps.runGit(opts.primary, io, [
    "diff",
    "--name-only",
    "--diff-filter=d",
    `develop...${opts.branch}`,
  ]);
  const changedRfcIds = [
    ...new Set(
      diff.stdout
        .split("\n")
        .map(
          (l) =>
            /^docs\/rfcs\/(?:archive\/(?:implemented|rejected|superseded)\/)?rfc-(\d+)-[^/]*\.md$/.exec(
              l.trim(),
            )?.[1],
        )
        .filter((m): m is string => m !== undefined)
        .map((n) => `RFC-${n.padStart(4, "0")}`),
    ),
  ];
  if (changedRfcIds.length > 0) {
    if (resolvable("rfc.validate")) {
      for (const id of changedRfcIds) {
        checked.push(`rfc.validate:${id}`);
        const result = await opts.invoke!("rfc.validate", { id });
        if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
          return {
            ok: false,
            checked,
            skipped,
            refuse: {
              ruleId: "FLOW-INT-13",
              message: `preflight: rfc.validate ${id} refused — ${result.summary ?? `exit ${result.exitCode}`}`,
              fixHint: "fix the RFC diagnostics, commit, then re-run flow.integrate",
              data: { command: "rfc.validate", id, summary: result.summary },
            },
          };
        }
      }
    } else {
      skipped.push({
        check: "rfc.validate",
        reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
      });
    }
  }

  // (5) friction.validate — a broken registry refuses early.
  if (resolvable("friction.validate")) {
    checked.push("friction.validate");
    const result = await opts.invoke!("friction.validate", {});
    if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
      return {
        ok: false,
        checked,
        skipped,
        refuse: {
          ruleId: "FLOW-INT-14",
          message: `preflight: friction.validate refused — ${result.summary ?? `exit ${result.exitCode}`}`,
          fixHint:
            "repair docs/frictions.yaml (e.g. a duplicate id), commit, then re-run flow.integrate",
          data: { command: "friction.validate", summary: result.summary },
        },
      };
    }
  } else {
    skipped.push({
      check: "friction.validate",
      reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
    });
  }

  return { ok: true, checked, skipped };
}
