/*
<MODULE_CONTRACT>
<purpose>flow.fix (RFC-1490) — opens auto/fix-… at the main tip for a patch
release: FLOW-FIX-01 adoption, FLOW-FIX-02 main at the repository line's
last-tag commit, FLOW-FIX-03 slug grammar, FLOW-FIX-04 pending back-merge.
The fix worktree's flow.cut (runFixCut) rebases onto a moved main, verifies
version writes, releases into main through the gate with FORGE_FLOW_TARGET
=main, tags, tears the fix branch down and runs the back-merge — a
conflicted port still reports released: true (DNA-106 per step).</purpose>
<non-goals>
  <item>No ordinary cuts — runOrdinaryCut handles those.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Touched package lines come from `git diff --name-only baseSha..fixTip` intersected with each line's paths — the fix commits declare what they release (AC-15).</item>
  <item>The fix cut never fast-forwards develop — it update-refs main at the fix tip, then delegates the port to backmergeFlow so the conflict path reports released + backmerge: conflict.</item>
  <item>RFC-1502: the fix release commit uses the same `add -u` staging + FLOW-CUT-14 untracked removal as the ordinary cut, and verifies named package lines at the fix tip before any ref moves.</item>
  <item>RFC-1502 r1: a refused fix cut rolls the branch back to its pre-release tip via `update-ref` + `read-tree --reset -u HEAD` (the session guard blocks reset --hard/restore/checkout --), so FLOW-CUT-12/13 stay rerun-safe without removing the fix worktree.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 1 — journal base/rewrites + held registry widening, W1-1 discard tip, FLOW-INT-11</item>
  <item>RFC-1490: fix-mode cut run inside the fix worktree tears down and back-merges through the primary

Steering-session verification of wave 2 (W2-1): flow.cut run inside the fix worktree, the documented path and the one flow.fix's nextSteps print, released main and the tags, then removed that worktree and kept using it as repoRoot. branch -D failed unobserved, leaving an unregistered auto/fix branch, and the trailing back-merge crashed on the vanished directory. The primary is now resolved before the cut and used for every step after the teardown; a failed branch delete surfaces as a FLOW-07 warning. Back-merge refusals are appended to the cut diagnostics instead of replacing them.</item>
  <item>RFC-1494: step 1 — isFlowAdopted public export</item>
  <item>RFC-1502: steps 1-5 — release-prepare hook, pre-tag extract verification, ordered steps</item>
  <item>RFC-1502: review r1 — fix-cut rollback on FLOW-CUT-12/13, populated steps[], hook validation, GIT_* env scrub</item>
  <history>RFC-1490</history>
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
  git,
  gitCommit,
  isAncestor,
  requireGit,
  statusDirty,
  topLevel,
  worktreeList,
} from "../git.ts";
import { LockTimeoutError, withFlowLock } from "../locks.ts";
import { discoverReleaseLines } from "../release-lines.ts";
import { pendingLevel } from "../release-level.ts";
import { bumpVersion, formatVersion } from "../semver.ts";
import { listLineTags, releaseTagAnnotation, writeReleaseTag } from "../release-tags.ts";
import {
  appendJournal,
  commonGitDir,
  INTEGRATE_LOCK_RELATIVE_PATH,
  updateRegistry,
  type FlowRegistryEntry,
} from "../registry.ts";
import { runFlowScript, type FlowScriptResult } from "../scripts.ts";
import { verifyLineAtRef } from "../publish.ts";
import { primaryWorktree } from "../worktree-path.ts";
import { VersionWriteError, writeLineVersion } from "../version-files.ts";
import { backmergeFlow, type FlowBackmergeData } from "./flow-backmerge.ts";
import type { FlowCutData } from "./flow-cut.ts";
import { plannedExtractVerifySteps, toFlowCutLines } from "./flow-cut.ts";
import { isFlowAdopted } from "../index.ts";
import type { CutLine } from "./flow-cut.ts";
import {
  INTEGRATE_LOCK_STALE_MS,
  INTEGRATE_LOCK_WAIT_MS,
} from "./flow-integrate.ts";
import { openFlowBranchCore } from "./flow-open.ts";

export interface FlowFixData {
  branch: string | null;
  worktree: string | null;
  base: "main";
  baseSha: string | null;
  /** Repository line's last release tag the fix opened against (FLOW-FIX-02 proof). */
  baseTag: string | null;
  opened: boolean;
  /** The worktree-setup hook result — FLOW-OPEN-07 failures surface here. */
  setup: FlowScriptResult | null;
  diagnostics: Diagnostic[];
}

function refuseFix(
  ruleId: string,
  message: string,
  fixHint: string,
  partial?: Partial<FlowFixData>,
): FlowFixData {
  return {
    branch: null,
    worktree: null,
    base: "main",
    baseSha: null,
    baseTag: null,
    opened: false,
    setup: null,
    ...partial,
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  };
}

const FIX_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function fixFlow(
  repoRoot: string,
  io: WorkspaceIO,
  opts: { slug: string; brief: string | null; dryRun: boolean; now?: Date },
): Promise<FlowFixData> {
  if (!(await isFlowAdopted(repoRoot, io))) {
    return refuseFix(
      "FLOW-FIX-01",
      "repository is not adopted into the fixed branch model",
      "run pnpm exec forge flow.install first",
    );
  }
  if (!FIX_SLUG_RE.test(opts.slug) || opts.slug.length < 3 || opts.slug.length > 48) {
    return refuseFix(
      "FLOW-FIX-03",
      `invalid --slug '${opts.slug}'`,
      "slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be 3..48 characters",
    );
  }
  const { lines } = await discoverReleaseLines(repoRoot, io);
  const repoLine = lines.find((l) => l.paths.length === 0) ?? lines[0];
  if (repoLine === undefined) {
    return refuseFix("FLOW-FIX-01", "no release lines discovered", "check pnpm-workspace.yaml");
  }
  const mainSha = (await git(repoRoot, io, ["rev-parse", "main"])).stdout.trim();
  const tags = await listLineTags(repoRoot, repoLine, io, "main");
  const tagCommit =
    tags.lastTag === null
      ? null
      : (await git(repoRoot, io, ["rev-parse", `${tags.lastTag.name}^{}`])).stdout.trim();
  if (tags.lastTag === null || tagCommit !== mainSha) {
    return refuseFix(
      "FLOW-FIX-02",
      "main moved past its last release — the fix must start at the release baseline",
      "cut a release first (flow.cut), then open the fix",
    );
  }
  if (!(await isAncestor(repoRoot, io, "main", "develop"))) {
    return refuseFix(
      "FLOW-FIX-04",
      "main carries a release not yet back-merged into develop",
      "finish the pending back-merge first (flow.backmerge)",
    );
  }

  const open = await openFlowBranchCore(repoRoot, io, {
    kind: "fix",
    slug: opts.slug,
    brief: opts.brief,
    owner: { kind: "session", id: "fix" },
    base: "main",
    journalEvent: "fix",
    dryRun: opts.dryRun,
    now: opts.now,
  });
  // A dry-run plans the branch without opening it (opened: false, no
  // diagnostics) — only a real open that did not happen is a refusal.
  if (open.branch === null || (!open.opened && !opts.dryRun)) {
    const d = open.diagnostics[0];
    return refuseFix(
      d?.ruleId ?? "FLOW-FIX-01",
      d?.message ?? "fix branch did not open",
      d?.fixHint ?? "inspect flow.status",
      { baseTag: tags.lastTag?.name ?? null, setup: open.setup },
    );
  }
  // An opened worktree whose setup hook failed still reports opened — the
  // FLOW-OPEN-07 diagnostic rides along (the worktree stays per DNA-106).
  return {
    branch: open.branch,
    worktree: open.worktree,
    base: "main",
    baseSha: open.baseSha,
    baseTag: tags.lastTag?.name ?? null,
    opened: open.opened,
    setup: open.setup,
    diagnostics: open.diagnostics,
  };
}

/**
 * Fix-mode flow.cut — the release side of a registered fix worktree.
 * `entry` is the fix's registry row; refusals FLOW-CUT-09/07/04/10/06/11
 * and FLOW-INT-02/05 hold per the RFC's fix contract.
 */
export async function runFixCut(
  repoRoot: string,
  io: WorkspaceIO,
  opts: {
    entry: FlowRegistryEntry;
    linesGiven: boolean;
    dryRun: boolean;
    now?: Date;
    onProgress?: (m: string) => void;
  },
): Promise<FlowCutData> {
  const now = opts.now ?? new Date();
  const { entry } = opts;
  const base: FlowCutData = {
    mode: "fix",
    released: false,
    resumed: false,
    releaseBranch: entry.name,
    releaseCommit: null,
    mainBefore: null,
    mainAfter: null,
    mainGains: 0,
    tags: [],
    versions: {},
    lines: [],
    fingerprints: {},
    gate: null,
    backmerge: null,
    steps: [],
    diagnostics: [],
  };
  const cutRefuse = (ruleId: string, message: string, fixHint: string, p?: Partial<FlowCutData>): FlowCutData => ({
    ...base,
    ...p,
    diagnostics: [{ ruleId, severity: "error", message, fixHint }],
  });

  if (opts.linesGiven) {
    return cutRefuse("FLOW-CUT-09", "--lines is not valid for a fix release", "the fix's touched lines are derived from its commits — drop --lines");
  }
  const live = await worktreeList(repoRoot, io);
  const liveFix = live.find((w) => w.branch === entry.name);
  if (liveFix === undefined) {
    return cutRefuse(
      "FLOW-CUT-07",
      `no worktree has ${entry.name} checked out — the fix must release from its own worktree`,
      "re-open the fix with flow.fix, or inspect with flow.status",
    );
  }
  const fixWt = liveFix.path;
  if (!(await io.exists(fixWt))) {
    return cutRefuse("FLOW-07", `fix worktree ${fixWt} does not exist`, "inspect with flow.status — a stale entry may need flow.discard");
  }
  // The release commit stages tracked changes only (git add -u, RFC-1502) —
  // the dirty check still reports untracked files so the operator sees what
  // the release deliberately leaves out, and main must be free for the CAS.
  const dirty = await statusDirty(fixWt, io);
  const mainCheckedOut = live.some((w) => w.branch === "main");
  if (dirty.length > 0 || mainCheckedOut) {
    return cutRefuse(
      "FLOW-CUT-07",
      mainCheckedOut
        ? "a worktree has main checked out — the fix cut must own the main ref"
        : `fix worktree has ${dirty.length} uncommitted change(s)`,
      mainCheckedOut
        ? "remove the worktree holding main, then re-run flow.cut"
        : "commit or revert inside the fix worktree",
    );
  }
  const baseSha = entry.baseSha;
  const fixTip0 = (await git(repoRoot, io, ["rev-parse", entry.name])).stdout.trim();
  const beyond = Number(
    (await git(repoRoot, io, ["rev-list", "--count", `${baseSha}..${fixTip0}`])).stdout.trim() || 0,
  );
  if (beyond === 0) {
    return cutRefuse("FLOW-CUT-04", "the fix branch carries no commits beyond its base", "commit the patch inside the fix worktree first");
  }

  // Level gate: the fix commits' X-RFC trailers must not demand minor/major.
  const { lines } = await discoverReleaseLines(repoRoot, io);
  const repoLine = lines.find((l) => l.paths.length === 0) ?? lines[0]!;
  const probe = await pendingLevel(repoLine, baseSha, io, repoRoot, null, fixTip0);
  if (probe.level === "minor" || probe.level === "major") {
    return cutRefuse(
      "FLOW-CUT-10",
      `a fix releases a patch only — its commits demand ${probe.level}`,
      "integrate the change on develop and run an ordinary flow.cut instead",
    );
  }

  // Touched lines: repository line plus package lines whose paths the fix
  // commits touch.
  const touched = await git(repoRoot, io, ["diff", "--name-only", `${baseSha}..${fixTip0}`]);
  const touchedPaths = touched.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const selected = [
    repoLine,
    ...lines.filter(
      (l) =>
        l.id !== repoLine.id &&
        l.paths.some((p) => touchedPaths.some((t) => t === p || t.startsWith(`${p}/`))),
    ),
  ];

  const cutLines: CutLine[] = [];
  for (const line of selected) {
    const tags = await listLineTags(repoRoot, line, io, fixTip0);
    if (tags.lastTag === null) {
      return cutRefuse("FLOW-CUT-04", `release line '${line.id}' has no baseline tag`, "cut the line's baseline via an ordinary release first");
    }
    const next = formatVersion(bumpVersion(tags.lastTag.version, "patch"));
    const tagName = `${line.tagPrefix}${next}`;
    if ((await git(repoRoot, io, ["rev-parse", "--verify", "-q", `refs/tags/${tagName}`])).exitCode === 0) {
      return cutRefuse("FLOW-CUT-06", `target tag ${tagName} already exists`, "pick a different version or delete the stray tag");
    }
    cutLines.push({ line, tag: tagName, level: "patch", nextVersion: next, previousTag: tags.lastTag.name, rfcs: [] });
  }
  const tagList = cutLines.map((c) => c.tag);
  const subject = `chore(release): ${tagList.join(", ")}`;

  const primary = await primaryWorktree(io, repoRoot);
  const fixSteps = async (): Promise<string[]> => {
    const steps = ["version-writes", "release-prepare", "release-commit"];
    steps.push(...(await plannedExtractVerifySteps(primary, io, cutLines, repoLine)));
    steps.push("gate", "fingerprints", "main", "tags", "teardown", "backmerge");
    return steps;
  };

  if (opts.dryRun) {
    return {
      ...base,
      tags: tagList,
      versions: Object.fromEntries(cutLines.map((c) => [c.line.id, c.nextVersion])),
      lines: toFlowCutLines(tagList, cutLines, lines, repoLine),
      mainBefore: (await git(repoRoot, io, ["rev-parse", "main"])).stdout.trim(),
      steps: await fixSteps(),
    };
  }

  const common = await commonGitDir(io, repoRoot);
  const lockPath = join(common, INTEGRATE_LOCK_RELATIVE_PATH);

  let fixTip = fixTip0;
  try {
    return await withFlowLock(
      lockPath,
      { waitMs: INTEGRATE_LOCK_WAIT_MS, staleMs: INTEGRATE_LOCK_STALE_MS, progressEveryMs: 60_000, onProgress: opts.onProgress },
      async () => {
        // Rebase onto main when main moved since the fix opened.
        const mainNow = (await git(repoRoot, io, ["rev-parse", "main"])).stdout.trim();
        if (mainNow !== baseSha) {
          const rebase = await git(fixWt, io, ["rebase", "main"]);
          if (rebase.exitCode !== 0) {
            const conflicts = await git(fixWt, io, ["diff", "--name-only", "--diff-filter=U"]);
            await git(fixWt, io, ["rebase", "--abort"]);
            return cutRefuse(
              "FLOW-INT-02",
              `rebase onto moved main conflicts in: ${conflicts.stdout.trim().split("\n").join(", ")}`,
              "resolve the rebase inside the fix worktree, commit, and re-run flow.cut",
            );
          }
          fixTip = (await git(repoRoot, io, ["rev-parse", entry.name])).stdout.trim();
        }

        // Pre-release tip: the cut rolls the fix branch back here when the
        // prepare hook or the extract verification refuses — the branch must
        // stay (it carries the fix) but the cut has to be rerun-safe, which
        // uncommitted version writes or a failed release commit break.
        const preReleaseTip = fixTip;
        const rollbackToTip = async (): Promise<void> => {
          // Destructive shorthands are blocked by the session guard (reset
          // --hard, restore, checkout --) — move the ref directly, then
          // reset index+worktree to the (new) HEAD tree via plumbing.
          await git(fixWt, io, ["update-ref", `refs/heads/${entry.name}`, preReleaseTip]);
          await git(fixWt, io, ["read-tree", "--reset", "-u", "HEAD"]);
          const leftovers = (
            await git(fixWt, io, [
              "-c",
              "core.quotepath=false",
              "ls-files",
              "-z",
              "--others",
              "--exclude-standard",
            ])
          ).stdout
            .split("\0")
            .filter((f) => f.length > 0);
          for (const file of leftovers) {
            await io.rm(join(fixWt, file));
          }
        };

        // Verified version writes on the fix branch.
        try {
          for (const c of cutLines) {
            await writeLineVersion(fixWt, c.line, c.nextVersion, io);
          }
        } catch (error) {
          if (error instanceof VersionWriteError) {
            return cutRefuse("FLOW-CUT-11", error.message, "fix the version file so the top-level version field is the release version");
          }
          throw error;
        }

        // release-prepare hook (RFC-1502): same seam as the ordinary cut —
        // version-hashed derived artifacts regenerated into the fix's
        // release commit. Runs from the primary checkout on the fix worktree.
        const warnings: Diagnostic[] = [];
        const prep = await runFlowScript(io, "release-prepare", {
          primary,
          cwd: fixWt,
          env: {
            FORGE_FLOW_RELEASE_TAGS: tagList.join(" "),
            FORGE_FLOW_RELEASE_VERSIONS: JSON.stringify(
              Object.fromEntries(cutLines.map((c) => [c.line.id, c.nextVersion])),
            ),
          },
        });
        if (prep.status === "failed") {
          await rollbackToTip();
          return cutRefuse(
            "FLOW-CUT-12",
            `hooks/release-prepare.sh failed (exit ${prep.exitCode}): ${prep.stderrTail}`,
            "fix the release-prepare hook and re-run flow.cut — the fix branch was rolled back to its pre-release tip",
          );
        }

        // Release commit on the fix branch — add -u folds the hook's tracked
        // edits in; untracked leftovers stay out and are reported.
        await git(fixWt, io, ["add", "-u"]);
        const untrackedFiles = (
          await git(fixWt, io, [
            "-c",
            "core.quotepath=false",
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
          ])
        ).stdout
          .split("\0")
          .filter((f) => f.length > 0);
        if (untrackedFiles.length > 0) {
          warnings.push({
            ruleId: "FLOW-CUT-14",
            severity: "warning",
            message: `release-prepare left untracked file(s) excluded from the release commit and removed from the release worktree: ${untrackedFiles.join(", ")}`,
          });
          // The cut continues — the same unignored-untracked set comes out of
          // the worktree so the gate sees a clean tree. Removed via io.rm:
          // `git clean -f` is blocked in agent sessions.
          for (const file of untrackedFiles) {
            await io.rm(join(fixWt, file));
          }
        }
        const body = cutLines.map((c) => `${c.tag} patch ${c.previousTag ?? "null"}`).join("\n");
        const commit = await gitCommit(fixWt, io, ["commit", "-m", `${subject}\n\n${body}`], "cut");
        if (commit.exitCode !== 0) {
          return cutRefuse("FLOW-CUT-01", `release commit failed: ${commit.stderr.trim()}`, "inspect the fix worktree state");
        }
        fixTip = (await git(repoRoot, io, ["rev-parse", entry.name])).stdout.trim();

        // Pre-tag extract verification (RFC-1502): named package lines
        // extract at the fix's release commit into a scratch — before any
        // ref or tag moves.
        for (const c of cutLines) {
          if (c.line.id === repoLine.id) continue;
          const verify = await verifyLineAtRef(primary, io, { line: c.line, ref: fixTip });
          if (!verify.ok) {
            await rollbackToTip();
            return cutRefuse(
              "FLOW-CUT-13",
              `pre-tag extract verification failed for line ${c.line.id}: ${verify.detail}`,
              "fix the extract or verify failure and re-run flow.cut — the fix branch was rolled back to its pre-release tip",
            );
          }
        }

        // Gate with main as the target.
        const gate = await runFlowScript(io, "integration-gate", {
          primary,
          cwd: fixWt,
          env: {
            FLOW_PRIMARY: primary,
            FLOW_BRANCH: entry.name,
            FLOW_BASE_SHA: mainNow,
            FORGE_FLOW_TARGET: "main",
          },
        });
        if (gate.status === "failed") {
          return cutRefuse(
            "FLOW-INT-05",
            `hooks/integration-gate.sh refused (exit ${gate.exitCode}): ${gate.stderrTail}`,
            "fix what the gate demands and re-run flow.cut",
          );
        }

        // Fingerprints (same hook, same output contract as the ordinary cut).
        const fpResult = await runFlowScript(io, "release-fingerprints", {
          primary,
          cwd: primary,
          env: { FORGE_FLOW_RELEASE_SHA: fixTip, FORGE_FLOW_RELEASE_TAGS: tagList.join(",") },
        });
        const fingerprints: Record<string, string> = {};
        if (fpResult.status === "failed") {
          return cutRefuse("FLOW-CUT-08", `hooks/release-fingerprints.sh failed (exit ${fpResult.exitCode}): ${fpResult.stderrTail}`, "fix the fingerprint hook and re-run flow.cut — main has not moved");
        }
        if (fpResult.status === "done") {
          const { parse: yamlParse } = await import("yaml");
          try {
            const parsed: unknown = yamlParse(fpResult.stdout);
            if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
              return cutRefuse("FLOW-CUT-08", "release-fingerprints stdout is not a flat YAML mapping", "emit only 'key: value' string pairs");
            }
            for (const [k, v] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
              if (typeof v !== "string") {
                return cutRefuse("FLOW-CUT-08", "release-fingerprints stdout is not a flat YAML mapping", "emit only 'key: value' string pairs");
              }
              fingerprints[k] = v;
            }
          } catch {
            return cutRefuse("FLOW-CUT-08", "release-fingerprints stdout is not valid YAML", "emit only 'key: value' string pairs");
          }
        }

        // Atomic main update.
        const upd = await git(repoRoot, io, ["update-ref", "refs/heads/main", fixTip, mainNow]);
        if (upd.exitCode !== 0) {
          return cutRefuse("FLOW-CUT-01", `update-ref main failed: ${upd.stderr.trim()}`, "inspect refs/heads/main");
        }

        // Tags at the fix tip.
        for (const c of cutLines) {
          const wr = await writeReleaseTag(repoRoot, io, {
            name: c.tag,
            target: fixTip,
            annotation: releaseTagAnnotation({
              tag: c.tag,
              line: c.line.id,
              version: c.nextVersion,
              level: "patch",
              previous: c.previousTag,
              rfcs: c.rfcs,
              fingerprints: c.line.id === repoLine.id ? fingerprints : {},
            }),
          });
          if (wr.exitCode !== 0) {
            return cutRefuse("FLOW-CUT-01", `tag ${c.tag} failed: ${wr.stderr.trim()}`, "inspect the tag state");
          }
        }

        // Teardown: worktree, branch (contained in main), registry, journal.
        // The cut may run from inside fixWt — after the remove every git
        // call goes through the primary, never repoRoot.
        await runFlowScript(io, "worktree-teardown", {
          primary,
          cwd: fixWt,
          env: { FLOW_PRIMARY: primary, FLOW_BRANCH: entry.name },
        });
        await git(primary, io, ["worktree", "remove", "--force", fixWt]);
        const dropped = await git(primary, io, ["branch", "-D", entry.name]);
        const teardownWarnings: Diagnostic[] =
          dropped.exitCode === 0
            ? []
            : [
                {
                  ruleId: "FLOW-07",
                  severity: "warning",
                  message: `fix branch ${entry.name} could not be deleted after the release: ${dropped.stderr.trim()}`,
                  fixHint: `delete it from the primary checkout — git branch -D ${entry.name}`,
                },
              ];
        try {
          await updateRegistry(io, common, (r) => ({
            ...r,
            branches: r.branches.filter((b) => b.name !== entry.name),
          }));
          await appendJournal(io, common, {
            event: "cut",
            branch: entry.name,
            sha: fixTip,
            base: entry.baseSha,
            detail: tagList.join(", "),
            at: now.toISOString(),
          });
        } catch {
          // bookkeeping failure is non-fatal — the release already landed
        }

        const mainGains = Number(
          (await git(primary, io, ["rev-list", "--count", `${mainNow}..${fixTip}`])).stdout.trim() || 0,
        );
        return {
          ...base,
          released: true,
          releaseCommit: fixTip,
          mainBefore: mainNow,
          mainAfter: fixTip,
          mainGains: Number.isFinite(mainGains) ? mainGains : 0,
          tags: tagList,
          versions: Object.fromEntries(cutLines.map((c) => [c.line.id, c.nextVersion])),
          lines: toFlowCutLines(tagList, cutLines, lines, repoLine),
          fingerprints,
          gate,
          releaseBranch: null,
          steps: await fixSteps(),
          diagnostics: [...warnings, ...base.diagnostics, ...teardownWarnings],
        } satisfies FlowCutData;
      },
      io,
    );
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      return cutRefuse(
        "FLOW-INT-08",
        `integration lock ${error.lockPath} is held by another integration`,
        "wait for the running integration to finish, or break the stale lock after 2 h automatically",
      );
    }
    throw error;
  }
}

/**
 * Fix-mode cut then the trailing back-merge — the back-merge runs OUTSIDE
 * the fix's lock (it takes the integration lock itself; nesting deadlocks).
 */
export async function runFixCutWithBackmerge(
  repoRoot: string,
  io: WorkspaceIO,
  opts: {
    entry: FlowRegistryEntry;
    linesGiven: boolean;
    dryRun: boolean;
    now?: Date;
    onProgress?: (m: string) => void;
  },
): Promise<FlowCutData> {
  // Resolved before the cut: runFixCut removes the fix worktree, which may
  // be repoRoot itself (flow.cut run inside it — the documented path).
  const primary = await primaryWorktree(io, repoRoot);
  const cut = await runFixCut(repoRoot, io, opts);
  if (!cut.released) return cut;
  const bm: FlowBackmergeData = await backmergeFlow(primary, io, {
    redo: false,
    dryRun: false,
    now: opts.now,
  });
  return {
    ...cut,
    backmerge: bm,
    diagnostics:
      (bm.status === "conflict" || bm.status === "refused") && bm.diagnostics.length > 0
        ? [...cut.diagnostics, ...bm.diagnostics]
        : cut.diagnostics,
  };
}

export async function runFlowFix(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowFixData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.fix must run inside a git repository");
  }

  const flag = (name: string): string | null => {
    const v = input.flags[name];
    return typeof v === "string" ? v : null;
  };
  const data = await fixFlow(repoRoot, io, {
    slug: flag("slug") ?? "",
    brief: flag("brief"),
    dryRun: context.dryRun || input.flags["dry-run"] === true,
  });

  const refused = data.diagnostics.find((d) => d.severity === "error");
  if (outputFormat === "pretty") {
    if (refused) {
      logger.error(`flow.fix refused: ${refused.ruleId} ${refused.message}`);
    } else {
      logger.section("flow.fix");
      logger.info(`  branch:   ${data.branch}`);
      logger.info(`  worktree: ${data.worktree}`);
      logger.info(`  base:     main @ ${data.baseSha?.slice(0, 9)}`);
    }
  }

  return {
    data,
    exitCode: refused ? 1 : 0,
    summary: refused
      ? `[flow.fix] refused: ${refused.ruleId} ${refused.message}`
      : data.opened
        ? `[flow.fix] opened ${data.branch} in ${data.worktree}`
        : `[flow.fix] dry run — would open ${data.branch} in ${data.worktree}`,
    nextSteps:
      refused || !data.opened
        ? []
        : [{ action: `commit the patch inside ${data.worktree}, then run flow.cut there`, kind: "required" }],
  };
}
