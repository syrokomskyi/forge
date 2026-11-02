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
  <item>RFC-1487: step 3 — flow.open handler</item>
  <item>RFC-1487: step 3 — flow.open with NN assignment over local/remote/registry names</item>
  <item>RFC-1487: close rfc-1487 review findings — dirty-check parity with git worktree remove, ownership-verified lock release, FLOW-07 registry-error mapping, residual RFC-1462 docs removed

The dirty gate for session worktrees now uses full porcelain status
(untracked files included) because it predicts 'git worktree remove';
the primary-clean gate keeps tracked-only semantics because it predicts
'merge --ff-only'. Lock release verifies the held payload before
unlinking. Registry/journal failures map to FLOW-07 in every handler.
The final branch-name collision reports FLOW-OPEN-04, flow.discard
propagates its teardown result and predicts FLOW-DIS-03 on --dry-run,
and integrate exposes teardown as its own field.</item>
  <item>RFC-1490: step 2 — registry fix/port widening, FORGE_FLOW_COMMIT gitCommit helper, verified version-files writes</item>
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
  git,
  listLocalBranches,
  listRemoteBranches,
  requireGit,
  topLevel,
} from "../git.ts";
import { formatFlowBranch, parseFlowBranch, type FlowBranchKind } from "../branch-name.ts";
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

export interface FlowOpenData {
  repoKind: "governed";
  branch: string | null;
  worktree: string | null;
  base: "develop";
  baseSha: string | null;
  opened: boolean;
  setup: FlowScriptResult | null;
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
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Highest NN for `date` among candidate auto branch names; returns max+1. */
export function nextFlowSeq(
  names: string[],
  yymmdd: string,
): number {
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
  const now = opts.now ?? new Date();

  // Flags — FLOW-OPEN-01/05 first, before any git fact is consulted.
  if (opts.kind !== "session" && opts.kind !== "task") {
    return refuse("FLOW-OPEN-01", `invalid --kind '${opts.kind}'`, "use --kind session or --kind task");
  }
  if (!SLUG_RE.test(opts.slug) || opts.slug.length < 3 || opts.slug.length > 48) {
    return refuse(
      "FLOW-OPEN-01",
      `invalid --slug '${opts.slug}'`,
      "slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be 3..48 characters",
    );
  }
  if (opts.kind === "task" && (opts.owner === null || opts.owner === "")) {
    return refuse(
      "FLOW-OPEN-05",
      "--kind task requires --owner <task-id>",
      "pass the queue task id via --owner, or use --kind session",
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

  if (!(await branchExists(repoRoot, io, "develop"))) {
    return refuse(
      "FLOW-OPEN-02",
      "local branch develop does not exist",
      "adopt the fixed branch model with flow.install first",
    );
  }
  const baseShaResult = await git(repoRoot, io, ["rev-parse", "refs/heads/develop"]);
  const baseSha = baseShaResult.stdout.trim();

  const primary = await primaryWorktree(io, repoRoot);
  const common = await commonGitDir(io, repoRoot);

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

  const ownerId = opts.owner ?? "unspecified";
  const iso = now.toISOString();

  for (let attempt = 1; attempt <= OPEN_MAX_ATTEMPTS; attempt++) {
    const name = formatFlowBranch({ kind: opts.kind as FlowBranchKind, date: now, seq, slug: opts.slug });
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
      return {
        repoKind: "governed",
        branch: name,
        worktree,
        base: "develop",
        baseSha,
        opened: false,
        setup: { status: "skipped", exitCode: null, stderrTail: "" },
        diagnostics: [],
      };
    }

    const add = await git(primary, io, [
      "worktree",
      "add",
      "-b",
      name,
      worktree,
      "develop",
    ]);
    if (add.exitCode !== 0) {
      const collision = add.stderr.includes("already exists") || add.stderr.includes("is already used");
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
        "FLOW-OPEN-01",
        `git worktree add -b ${name} failed (exit ${add.exitCode}): ${add.stderr.trim()}`,
        "inspect the git error — a stale ref or lock may need cleanup",
      );
    }

    const entry: FlowRegistryEntry = {
      name,
      kind: opts.kind,
      base: "develop",
      baseSha,
      worktree,
      owner: { kind: opts.kind, id: ownerId },
      brief: opts.brief,
      openedAt: iso,
      updatedAt: iso,
      held: null,
      port: null,
    };
    try {
      await updateRegistry(io, common, (r) => ({
        ...r,
        branches: [...r.branches.filter((b) => b.name !== name), entry],
      }));
      await appendJournal(io, common, {
        at: iso,
        event: "open",
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

    return {
      repoKind: "governed",
      branch: name,
      worktree,
      base: "develop",
      baseSha,
      opened: true,
      setup,
      diagnostics: setupDiag,
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
