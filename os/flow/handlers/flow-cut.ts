/*
<MODULE_CONTRACT>
<purpose>flow.cut — the ordinary release on the fixed branch model
(RFC-1490). Plan phase refuses before any mutation (FLOW-CUT-01..07);
execute runs under the integration lock: release branch via openFlowBranchCore,
verified version-file writes, release commit, gate+ff through
integrateFlowBranch(lockHeld), fingerprints hook, main compare-and-swap,
release tags, journal. Rerun-safe: a develop tip already carrying the
release subject resumes at fingerprints; a fully tagged tip reports
released with no mutation.</purpose>
<non-goals>
  <item>No fix releases — flow.cut's fix mode lives alongside (step 6).</item>
  <item>No pushing — outbound is the next RFC.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The integration lock spans open→main-move so no second integration can interleave between the gate and the main fast-forward.</item>
  <item>Version writes are verified textual replacements (VersionWriteError → FLOW-CUT-11); the release branch is removed on that failure per AUDIT-RFC-1490-C3.</item>
  <item>Resume keys on the develop tip's `chore(release):` subject — the subject is the persisted declaration of which tags the release intends.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
  <item>RFC-1490: step 6 — flow.fix + fix-mode cut (patch-only, rebase on moved main, gate target main, trailing back-merge)</item>
  <item>RFC-1490: independent-review pass — lock-held planning, fix-branch verification, spec-shaped data, coverage</item>
  <item>RFC-1491: step 1 — journal base/rewrites + held registry widening, W1-1 discard tip, FLOW-INT-11</item>
  <item>RFC-1494: step 1 — isFlowAdopted public export</item>
  <history>RFC-1490</history>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import { parse as yamlParse } from "yaml";

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
  gitCommit,
  isAncestor,
  requireGit,
  statusTracked,
  topLevel,
  worktreeList,
} from "../git.ts";
import { LockTimeoutError, withFlowLock } from "../locks.ts";
import { isFlowAdopted } from "../index.ts";
import {
  appendJournal,
  commonGitDir,
  FlowRegistrySchemaError,
  INTEGRATE_LOCK_RELATIVE_PATH,
  readRegistry,
  registryPath,
} from "../registry.ts";
import { bumpVersion, formatVersion, type ReleaseLevel } from "../semver.ts";
import { discoverReleaseLines, type ReleaseLine } from "../release-lines.ts";
import { pendingLevel } from "../release-level.ts";
import {
  listLineTags,
  releaseTagAnnotation,
  writeReleaseTag,
} from "../release-tags.ts";
import { runFlowScript, type FlowScriptResult } from "../scripts.ts";
import { VersionWriteError, writeLineVersion, writeSyncedForgeVersion } from "../version-files.ts";
import { primaryWorktree } from "../worktree-path.ts";
import { integrateFlowBranch } from "./flow-integrate.ts";
import { openFlowBranchCore } from "./flow-open.ts";
import { INTEGRATE_LOCK_STALE_MS, INTEGRATE_LOCK_WAIT_MS } from "./flow-integrate.ts";
import type { FlowBackmergeData } from "./flow-backmerge.ts";

/** One released line as the --json contract reports it (spec §TypeScript contracts). */
export interface FlowCutLine {
  line: string;
  tag: string;
  previous: string | null;
  level: ReleaseLevel;
  version: string;
  rfcs: string[];
}

export interface FlowCutData {
  mode: "ordinary" | "fix";
  released: boolean;
  /** True when this invocation only completed a previous cut's tail. */
  resumed: boolean;
  releaseBranch: string | null;
  /** SHA of the integrated `chore(release):` commit (main tip after the cut). */
  releaseCommit: string | null;
  mainBefore: string | null;
  mainAfter: string | null;
  /** Commits main gained (W1-3 — first cut includes the adoption commit). */
  mainGains: number;
  /** Tag names applied to the main tip, line order (repository line first). */
  tags: string[];
  /** Versions per line id. */
  versions: Record<string, string>;
  lines: FlowCutLine[];
  fingerprints: Record<string, string>;
  /** The integration-gate result when it ran this invocation (null on resume). */
  gate: FlowScriptResult | null;
  /** Fix mode only: the trailing back-merge's full data (null on ordinary cuts). */
  backmerge: FlowBackmergeData | null;
  diagnostics: Diagnostic[];
}

export interface CutLine {
  line: ReleaseLine;
  tag: string;
  level: ReleaseLevel;
  nextVersion: string;
  previousTag: string | null;
  rfcs: string[];
}

function refuse(
  ruleId: string,
  message: string,
  fixHint: string,
  partial?: Partial<FlowCutData>,
): FlowCutData {
  return {
    mode: partial?.mode ?? "ordinary",
    released: false,
    resumed: false,
    releaseBranch: null,
    releaseCommit: null,
    mainBefore: null,
    mainAfter: null,
    mainGains: 0,
    tags: partial?.tags ?? [],
    versions: {},
    lines: [],
    fingerprints: {},
    gate: null,
    backmerge: null,
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

/** Flat YAML mapping of string→string; anything else fails FLOW-CUT-08. */
function parseFingerprints(stdout: string): Record<string, string> | null {
  try {
    const parsed: unknown = yamlParse(stdout);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

interface CutPlan {
  /** develop tip resolved at plan time. */
  ref: string;
  /** Subject-named tags with ≥1 missing OR main behind → run the tail for them. */
  resumeTags: string[] | null;
  cutLines: CutLine[];
  tagList: string[];
  subject: string;
  allLines: ReleaseLine[];
  repoLine: ReleaseLine;
  mainTip: string;
  primary: string;
}

type PlanOutcome =
  | { kind: "completed"; ref: string; tags: string[]; allLines: ReleaseLine[]; mainTip: string }
  | { kind: "plan"; plan: CutPlan }
  | { kind: "refusal"; data: FlowCutData };

/**
 * Plan phase — every refusal before any mutation. The mutation path runs
 * this INSIDE the integration lock so a landing integration between the
 * dry-plan and the branch-open can never sneak unvetted commits into the
 * release (all refs are resolved at lock time).
 */
async function planOrdinaryCut(
  repoRoot: string,
  io: WorkspaceIO,
  opts: { lines: string[] },
): Promise<PlanOutcome> {
  const primary = await primaryWorktree(io, repoRoot);
  const guardInstalled = await isFlowAdopted(repoRoot, io);
  if (!guardInstalled) {
    return {
      kind: "refusal",
      data: refuse(
        "FLOW-CUT-01",
        "repository is not adopted into the fixed branch model (governed + guard installed + develop)",
        "run pnpm exec forge flow.install, then re-run flow.cut",
      ),
    };
  }

  const mainExists = await branchExists(repoRoot, io, "main");
  if (mainExists && !(await isAncestor(repoRoot, io, "main", "develop"))) {
    return {
      kind: "refusal",
      data: refuse(
        "FLOW-CUT-02",
        "main carries a release not yet back-merged into develop",
        "run pnpm exec forge flow.backmerge first",
      ),
    };
  }

  const { lines, diagnostics: discoveryDiags } = await discoverReleaseLines(repoRoot, io);
  if (discoveryDiags.some((d) => d.severity === "error")) {
    return {
      kind: "refusal",
      data: refuse(
        "FLOW-CUT-01",
        discoveryDiags.map((d) => d.message).join("; "),
        "fix the release-line discovery errors",
      ),
    };
  }
  const repoLine = lines.find((l) => l.paths.length === 0) ?? lines[0];
  if (repoLine === undefined) {
    return {
      kind: "refusal",
      data: refuse(
        "FLOW-CUT-01",
        "no release lines discovered — the repository line is mandatory",
        "check pnpm-workspace.yaml and package.json",
      ),
    };
  }
  const selected: ReleaseLine[] = [repoLine];
  for (const id of opts.lines) {
    const found = lines.find((l) => l.id === id);
    if (found === undefined || found.id === repoLine.id) {
      return {
        kind: "refusal",
        data: refuse(
          "FLOW-CUT-03",
          `unknown release line '${id}' — known lines: ${lines.map((l) => l.id).join(", ")}`,
          "pass only ids from flow.version --json",
        ),
      };
    }
    selected.push(found);
  }

  const ref = (await git(repoRoot, io, ["rev-parse", "develop"])).stdout.trim();
  const mainTip = mainExists
    ? (await git(repoRoot, io, ["rev-parse", "main"])).stdout.trim()
    : "";

  // Resume detection runs before the pending-level loop: a develop tip
  // carrying `chore(release):` is this cut's own persisted declaration. All
  // named tags present AND main already at the tip → the release completed
  // (rerun reports, no mutation); any missing or a rewound main → the plan
  // still runs but the tail completes exactly the subject's tags (and tags
  // the subject names cannot block as FLOW-CUT-06).
  const tipSubject = (
    await git(repoRoot, io, ["log", "-1", "--format=%s", ref])
  ).stdout.trim();
  let resumeTags: string[] | null = null;
  if (tipSubject.startsWith("chore(release): ")) {
    const named = tipSubject
      .slice("chore(release): ".length)
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const existence = await Promise.all(
      named.map(
        async (t) =>
          (await git(repoRoot, io, ["rev-parse", "--verify", "-q", `refs/tags/${t}`])).exitCode ===
          0,
      ),
    );
    if (named.length > 0 && existence.every((e) => e) && mainTip === ref) {
      return { kind: "completed", ref, tags: named, allLines: lines, mainTip };
    }
    if (named.length > 0) resumeTags = named;
  }

  const cutLines: CutLine[] = [];
  const majorDemands: string[] = [];
  for (const line of selected) {
    const tags = await listLineTags(repoRoot, line, io, ref);
    if (tags.lastTag === null) {
      return {
        kind: "refusal",
        data: refuse(
          "FLOW-CUT-04",
          `release line '${line.id}' has no baseline tag`,
          "run pnpm exec forge flow.install to create the baseline tag",
        ),
      };
    }
    const pending = await pendingLevel(
      line,
      tags.lastTag.name,
      io,
      repoRoot,
      tags.lastTag.version,
      ref,
    );
    if (pending.level === "none") {
      return {
        kind: "refusal",
        data: refuse(
          "FLOW-CUT-04",
          line.id === repoLine.id
            ? "nothing to release — the repository line has no pending commits"
            : `release line '${line.id}' has no pending commits`,
          "drop the line from --lines, or land work touching its paths first",
        ),
      };
    }
    const next = formatVersion(bumpVersion(tags.lastTag.version, pending.level));
    if (pending.level === "major") {
      majorDemands.push(
        `${line.id} (${pending.rfcs.map((r) => r.id).join(", ") || "no RFC trailer"})`,
      );
    }
    const tagName = `${line.tagPrefix}${next}`;
    const tagRef = `refs/tags/${tagName}`;
    const namedInSubject = resumeTags !== null && resumeTags.includes(tagName);
    if (
      !namedInSubject &&
      (await git(repoRoot, io, ["rev-parse", "--verify", "-q", tagRef])).exitCode === 0
    ) {
      return {
        kind: "refusal",
        data: refuse(
          "FLOW-CUT-06",
          `target tag ${line.tagPrefix}${next} already exists`,
          "pick a different version or delete the stray tag if it was never published",
        ),
      };
    }
    cutLines.push({
      line,
      tag: tagName,
      level: pending.level,
      nextVersion: next,
      previousTag: tags.lastTag.name,
      rfcs: pending.rfcs.map((r) => r.id),
    });
  }

  if (majorDemands.length > 0 && process.env["ALLOW_MAJOR_BUMP"] !== "1") {
    return {
      kind: "refusal",
      data: refuse(
        "FLOW-CUT-05",
        `release requires a major bump on: ${majorDemands.join("; ")}`,
        "re-run with ALLOW_MAJOR_BUMP=1 in the environment — major cuts are operator-only",
      ),
    };
  }

  const primaryBranch = await currentBranch(primary, io);
  const primaryDirty = await statusTracked(primary, io);
  const worktrees = await worktreeList(repoRoot, io);
  const mainCheckedOut = worktrees.some((w) => w.branch === "main");
  if (primaryBranch !== "develop" || primaryDirty.length > 0 || mainCheckedOut) {
    return {
      kind: "refusal",
      data: refuse(
        "FLOW-CUT-07",
        primaryBranch !== "develop"
          ? `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`
          : mainCheckedOut
            ? "a worktree has main checked out — the cut must own the main ref"
            : `primary worktree has ${primaryDirty.length} tracked uncommitted change(s)`,
        "switch the primary to develop, commit or revert its changes, and ensure no worktree holds main",
      ),
    };
  }

  const tagList = cutLines.map((c) => c.tag);
  return {
    kind: "plan",
    plan: {
      ref,
      resumeTags,
      cutLines,
      tagList,
      subject: `chore(release): ${tagList.join(", ")}`,
      allLines: lines,
      repoLine,
      mainTip,
      primary,
    },
  };
}

/** The line a subject-named tag belongs to — longest matching prefix wins. */
function lineForTag(tag: string, allLines: ReleaseLine[], repoLine: ReleaseLine): ReleaseLine {
  const match = allLines
    .filter((l) => l.id !== repoLine.id && tag.startsWith(l.tagPrefix))
    .sort((a, b) => b.tagPrefix.length - a.tagPrefix.length)[0];
  return match ?? repoLine;
}

/** Spec-shape `lines[]` for the report — one entry per applied tag. */
export function toFlowCutLines(
  tagNames: string[],
  cutLines: CutLine[],
  allLines: ReleaseLine[],
  repoLine: ReleaseLine,
): FlowCutLine[] {
  return tagNames.map((tag) => {
    const c = cutLines.find((cl) => cl.tag === tag);
    if (c !== undefined) {
      return {
        line: c.line.id,
        tag,
        previous: c.previousTag,
        level: c.level,
        version: c.nextVersion,
        rfcs: c.rfcs,
      };
    }
    const line = lineForTag(tag, allLines, repoLine);
    return {
      line: line.id,
      tag,
      previous: null,
      level: "patch" as const,
      version: tag.slice(line.tagPrefix.length),
      rfcs: [],
    };
  });
}

function completedReleaseData(outcome: {
  ref: string;
  tags: string[];
  allLines: ReleaseLine[];
  mainTip: string;
}): FlowCutData {
  const repoLine = outcome.allLines.find((l) => l.paths.length === 0) ?? outcome.allLines[0]!;
  return {
    mode: "ordinary",
    released: true,
    resumed: true,
    releaseBranch: null,
    releaseCommit: outcome.ref,
    mainBefore: outcome.mainTip,
    mainAfter: outcome.ref,
    mainGains: 0,
    tags: outcome.tags,
    versions: {},
    lines: toFlowCutLines(outcome.tags, [], outcome.allLines, repoLine),
    fingerprints: {},
    gate: null,
    backmerge: null,
    diagnostics: [],
  };
}

/**
 * Ordinary cut core — callable with an injected clock. Plan-phase refusals
 * resolve inside the integration lock (the world can change while a caller
 * waits), then the release runs open→integrate→fingerprints→main→tags→journal
 * without ever dropping the lock. A develop tip already carrying the release
 * subject resumes at fingerprints; a fully landed release reports released.
 */
export async function runOrdinaryCut(
  repoRoot: string,
  io: WorkspaceIO,
  opts: {
    lines: string[];
    dryRun: boolean;
    now?: Date;
    onProgress?: (m: string) => void;
  },
): Promise<FlowCutData> {
  const now = opts.now ?? new Date();

  if (opts.dryRun) {
    const outcome = await planOrdinaryCut(repoRoot, io, opts);
    if (outcome.kind === "refusal") return outcome.data;
    if (outcome.kind === "completed") return completedReleaseData(outcome);
    const { plan } = outcome;
    return {
      mode: "ordinary",
      released: false,
      resumed: false,
      releaseBranch: null,
      releaseCommit: null,
      mainBefore: plan.mainTip.length > 0 ? plan.mainTip : null,
      mainAfter: null,
      mainGains: 0,
      tags: plan.tagList,
      versions: Object.fromEntries(plan.cutLines.map((c) => [c.line.id, c.nextVersion])),
      lines: toFlowCutLines(plan.tagList, plan.cutLines, plan.allLines, plan.repoLine),
      fingerprints: {},
      gate: null,
      backmerge: null,
      diagnostics: [],
    };
  }

  const common = await commonGitDir(io, repoRoot);
  await io.mkdir(join(common, "forge"));
  const lockPath = join(common, INTEGRATE_LOCK_RELATIVE_PATH);

  let releaseBranch: string | null = null;
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
        // Plan at lock time — no stale-ref races against landing integrations.
        const outcome = await planOrdinaryCut(repoRoot, io, opts);
        if (outcome.kind === "refusal") return outcome.data;
        if (outcome.kind === "completed") return completedReleaseData(outcome);
        const plan = outcome.plan;
        const { cutLines, tagList, subject, repoLine, primary } = plan;

        // Resume tail: release commit integrated earlier; finish at
        // fingerprints → main → tags with exactly the subject's named tags.
        if (plan.resumeTags !== null) {
          // The release branch is linear — tip^ is the develop tip the
          // integration started from, the honest journal base on a rerun.
          const base = (await git(repoRoot, io, ["rev-parse", `${plan.ref}^`])).stdout.trim();
          const resume = await finishCutTail(repoRoot, io, {
            developTip: plan.ref,
            tagNames: plan.resumeTags,
            cutLines,
            allLines: plan.allLines,
            repoLine,
            primary,
            now,
            gate: null,
            journalBranch: "release",
            journalBase: base,
          });
          return { ...resume, resumed: true };
        }

        // 1. release branch.
        const open = await openFlowBranchCore(repoRoot, io, {
          kind: "session",
          slug: `release-${cutLines[0]!.nextVersion.replaceAll(".", "-")}`,
          brief: `release ${tagList.join(", ")}`,
          owner: { kind: "session", id: "release" },
          dryRun: false,
          now,
        });
        if (!open.opened || open.branch === null || open.worktree === null) {
          const d = open.diagnostics[0];
          return refuse(
            d?.ruleId ?? "FLOW-CUT-01",
            d?.message ?? "release branch did not open",
            d?.fixHint ?? "inspect flow.status",
          );
        }
        releaseBranch = open.branch;
        const wt = open.worktree;

        // 2. version files (verified writes).
        try {
          for (const c of cutLines) {
            await writeLineVersion(wt, c.line, c.nextVersion, io);
            if (c.line.id !== repoLine.id) {
              const pkg = JSON.parse(
                await io.readFile(join(wt, c.line.versionFile ?? "package.json")),
              ) as { name?: string };
              if (pkg.name === "@warpgogol/forge") {
                const forgeYaml = join(wt, "forge.yaml");
                if ((await io.exists(forgeYaml)) && /syncedVersion:/.test(await io.readFile(forgeYaml))) {
                  await writeSyncedForgeVersion(wt, c.nextVersion, io);
                }
              }
            }
          }
        } catch (error) {
          if (error instanceof VersionWriteError) {
            await git(repoRoot, io, ["worktree", "remove", "--force", wt]);
            await git(repoRoot, io, ["branch", "-D", releaseBranch]);
            return refuse(
              "FLOW-CUT-11",
              `${error.message}`,
              "fix the version file so the top-level version field is the release version",
              { releaseBranch },
            );
          }
          throw error;
        }

        // 3. release commit.
        await git(wt, io, ["add", "-A"]);
        const body = cutLines
          .map((c) => `${c.tag} ${c.level} ${c.previousTag ?? "null"}`)
          .join("\n");
        const commit = await gitCommit(wt, io, ["commit", "-m", `${subject}\n\n${body}`], "cut");
        if (commit.exitCode !== 0) {
          return refuse("FLOW-CUT-01", `release commit failed: ${commit.stderr.trim()}`, "inspect the release worktree state", { releaseBranch });
        }

        // 4. integrate (gate + ff + cleanup) with the lock already held.
        const integrated = await integrateFlowBranch(repoRoot, io, {
          branch: releaseBranch,
          dryRun: false,
          now,
          lockHeld: true,
          target: "develop",
        });
        if (!integrated.integrated || integrated.diagnostics.length > 0) {
          const d = integrated.diagnostics[0];
          return refuse(
            d?.ruleId ?? "FLOW-INT-05",
            d?.message ?? "integration failed",
            d?.fixHint ?? "inspect the gate output",
            { releaseBranch, gate: integrated.gate },
          );
        }

        // 5–8. fingerprints → main → tags → journal.
        return finishCutTail(repoRoot, io, {
          developTip: integrated.developAfter ?? plan.ref,
          tagNames: tagList,
          cutLines,
          allLines: plan.allLines,
          repoLine,
          primary,
          now,
          gate: integrated.gate,
          journalBranch: releaseBranch,
          journalBase: integrated.developBefore ?? plan.ref,
        });
      },
      io,
    );
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return refuse(
        "FLOW-INT-08",
        `integration lock ${error.lockPath} is held by another integration`,
        "wait for the running integration to finish, or break the stale lock after 2 h automatically",
        { releaseBranch },
      );
    }
    if (error instanceof FlowRegistrySchemaError) {
      return refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`, { releaseBranch });
    }
    throw error;
  }
}

/** Steps 5–8 shared by the fresh path and the resume path. */
async function finishCutTail(
  repoRoot: string,
  io: WorkspaceIO,
  args: {
    developTip: string;
    tagNames: string[];
    cutLines: CutLine[];
    allLines: ReleaseLine[];
    repoLine: ReleaseLine;
    primary: string;
    now: Date;
    gate: FlowScriptResult | null;
    /** Branch name the journal records ("release" on resume — the branch is gone). */
    journalBranch: string;
    /** Journal `base` — develop before the release range (W1-1). */
    journalBase: string;
  },
): Promise<FlowCutData> {
  const { developTip, tagNames, cutLines, allLines, repoLine, primary, gate } = args;

  // 5. fingerprints.
  const fpResult = await runFlowScript(io, "release-fingerprints", {
    primary,
    cwd: primary,
    env: {
      FORGE_FLOW_RELEASE_SHA: developTip,
      FORGE_FLOW_RELEASE_TAGS: tagNames.join(","),
    },
  });
  let fingerprints: Record<string, string> = {};
  if (fpResult.status === "failed") {
    return refuse(
      "FLOW-CUT-08",
      `hooks/release-fingerprints.sh failed (exit ${fpResult.exitCode}): ${fpResult.stderrTail}`,
      "fix the fingerprint hook and re-run flow.cut — main has not moved",
    );
  }
  if (fpResult.status === "done") {
    const parsed = parseFingerprints(fpResult.stdout);
    if (parsed === null) {
      return refuse(
        "FLOW-CUT-08",
        "hooks/release-fingerprints.sh stdout is not a flat YAML mapping of string keys to string values",
        "emit only 'key: value' string pairs on stdout",
      );
    }
    fingerprints = parsed;
  }

  // 6. main compare-and-swap.
  const mainTipBefore = (await git(repoRoot, io, ["rev-parse", "main"])).stdout.trim();
  if (await branchExists(repoRoot, io, "main")) {
    if (!(await isAncestor(repoRoot, io, "main", "develop"))) {
      return refuse(
        "FLOW-CUT-02",
        "main moved past develop mid-cut",
        "run pnpm exec forge flow.backmerge, then re-run flow.cut",
      );
    }
    const upd = await git(repoRoot, io, ["update-ref", "refs/heads/main", developTip, mainTipBefore]);
    if (upd.exitCode !== 0) {
      return refuse("FLOW-CUT-01", `update-ref main failed: ${upd.stderr.trim()}`, "inspect refs/heads/main");
    }
  } else {
    const upd = await git(repoRoot, io, ["update-ref", "refs/heads/main", developTip]);
    if (upd.exitCode !== 0) {
      return refuse("FLOW-CUT-01", `update-ref main failed: ${upd.stderr.trim()}`, "inspect refs/heads/main");
    }
  }

  // 7. tags — iterate the declared names (subject tags on resume) and look
  // each up in the computed cut lines; a named-only tag gets a patch stub on
  // its own line (matched by tag prefix). A tag already pointing at the tip
  // is skipped — rerun-safe against a crash between two git tag calls; a tag
  // pointing elsewhere refuses instead of silently moving it.
  for (const tag of tagNames) {
    const existing = await git(repoRoot, io, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{}`]);
    if (existing.exitCode === 0) {
      if (existing.stdout.trim() === developTip) continue;
      return refuse(
        "FLOW-CUT-06",
        `tag ${tag} already exists at ${existing.stdout.trim().slice(0, 9)}, not the release tip`,
        "delete the stray tag if it was never published, or pick a different version",
      );
    }
    const c = cutLines.find((cl) => cl.tag === tag) ?? (() => {
      const line = lineForTag(tag, allLines, repoLine);
      return {
        line,
        tag,
        level: "patch" as const,
        nextVersion: tag.slice(line.tagPrefix.length),
        previousTag: null,
        rfcs: [] as string[],
      };
    })();
    const wr = await writeReleaseTag(repoRoot, io, {
      name: tag,
      target: developTip,
      annotation: releaseTagAnnotation({
        tag,
        line: c.line.id,
        version: c.nextVersion,
        level: c.level,
        previous: c.previousTag,
        rfcs: c.rfcs,
        fingerprints: c.line.id === repoLine.id ? fingerprints : {},
      }),
    });
    if (wr.exitCode !== 0) {
      return refuse("FLOW-CUT-01", `tag ${tag} failed: ${wr.stderr.trim()}`, "inspect the tag state");
    }
  }

  // 8. journal.
  const common = await commonGitDir(io, repoRoot);
  try {
    await appendJournal(io, common, {
      event: "cut",
      branch: args.journalBranch,
      sha: developTip,
      base: args.journalBase,
      detail: tagNames.join(", "),
      at: args.now.toISOString(),
    });
  } catch {
    // journal failure is non-fatal bookkeeping.
  }

  const mainGains = mainTipBefore.length > 0
    ? Number((await git(repoRoot, io, ["rev-list", "--count", `${mainTipBefore}..${developTip}`])).stdout.trim() || 0)
    : 0;

  return {
    mode: "ordinary",
    released: true,
    resumed: false,
    releaseBranch: null,
    releaseCommit: developTip,
    mainBefore: mainTipBefore.length > 0 ? mainTipBefore : null,
    mainAfter: developTip,
    mainGains: Number.isFinite(mainGains) ? mainGains : 0,
    tags: tagNames,
    versions: Object.fromEntries(cutLines.map((c) => [c.line.id, c.nextVersion])),
    lines: toFlowCutLines(tagNames, cutLines, allLines, repoLine),
    fingerprints,
    gate,
    backmerge: null,
    diagnostics: [],
  };
}

export async function runFlowCut(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowCutData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.cut must run inside a git repository");
  }

  const linesFlag = input.flags["lines"];
  const lines =
    typeof linesFlag === "string" && linesFlag.length > 0
      ? linesFlag.split(",").map((s) => s.trim())
      : [];
  const dryRun = context.dryRun || input.flags["dry-run"] === true;

  // Fix mode: --branch names a registered fix branch, or the cwd worktree is
  // itself a registered fix worktree.
  const branchFlag = input.flags["branch"];
  const candidate =
    typeof branchFlag === "string" && branchFlag.length > 0
      ? branchFlag
      : await currentBranch(repoRoot, io);
  let data: FlowCutData;
  if (candidate !== null) {
    const common = await commonGitDir(io, repoRoot);
    let entry = null;
    try {
      entry =
        (await readRegistry(io, common)).branches.find((b) => b.name === candidate) ?? null;
    } catch (error) {
      if (error instanceof FlowRegistrySchemaError) {
        data = refuse("FLOW-07", error.message, `repair or remove ${registryPath(common)}`);
        return finishCutResult(data, outputFormat, logger);
      }
      throw error;
    }
    if (entry !== null && entry.kind === "fix") {
      const { runFixCutWithBackmerge } = await import("./flow-fix.ts");
      data = await runFixCutWithBackmerge(repoRoot, io, {
        entry,
        linesGiven: lines.length > 0,
        dryRun,
      });
      return finishCutResult(data, outputFormat, logger);
    }
    if (typeof branchFlag === "string" && entry?.kind !== "fix") {
      data = refuse(
        "FLOW-INT-06",
        `${candidate} is not a fix branch — --branch targets a registered fix worktree only`,
        "run flow.cut without --branch for an ordinary release, or open a fix with flow.fix",
      );
      return finishCutResult(data, outputFormat, logger);
    }
  }

  data = await runOrdinaryCut(repoRoot, io, { lines, dryRun });
  return finishCutResult(data, outputFormat, logger);
}

function finishCutResult(
  data: FlowCutData,
  outputFormat: string,
  logger: ForgeRuntimeContext["logger"],
): ForgeCommandResult<FlowCutData> {

  const refused = data.diagnostics.find((d) => d.severity === "error");
  if (outputFormat === "pretty") {
    if (refused) {
      logger.error(`flow.cut refused: ${refused.ruleId} ${refused.message}`);
    } else if (data.released) {
      logger.section("flow.cut");
      logger.info(`  ${data.resumed ? "resumed release" : "released"}: ${data.tags.join(", ")}`);
      logger.info(`  main gained ${data.mainGains} commit(s) — now at ${data.mainAfter?.slice(0, 9)}`);
      if (data.mainGains > 0 && !data.resumed) {
        logger.info("  the first cut after flow.install includes the guard-adoption commit");
      }
    }
  }

  return {
    data,
    exitCode: refused ? 1 : 0,
    summary: refused
      ? `[flow.cut] refused: ${refused.ruleId} ${refused.message}`
      : `[flow.cut] ${data.released ? `released ${data.tags.join(", ")}` : "dry-run"}`,
  };
}
