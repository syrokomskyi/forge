/*
<MODULE_CONTRACT>
<purpose>flow.install — repository adoption for the fixed branch model
(RFC-1486). Two phases: planInstall evaluates steps 1–5 preconditions and the
hook-file diffs without mutating (a refusal exits 1 with nothing changed,
--dry-run stops here); executeInstall performs steps 3–9 in order, ending
with one adoption commit on develop under FORGE_FLOW_OP=install and an
embedded flow.check report.</purpose>
<non-goals>
  <item>Never refuses anything a later refusal could invalidate — all FLOW-ADOPT refusals are detected in the plan phase.</item>
  <item>Never touches refs other than develop/HEAD, remote refs, or files outside hooks/ and .git/config.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>develop checked out in a dirty linked worktree → FLOW-ADOPT-04; checked out cleanly → ff-merge inside that worktree (branch -f cannot move a checked-out ref).</item>
  <item>develop checked out in a NON-primary worktree while the primary sits on main → FLOW-ADOPT-08: the adoption commit must land in the primary on develop, and git refuses a double checkout.</item>
  <item>Step 8 passes FORGE_FLOW_OP=install only to the commit child — the closed vocabulary is the guard's own escape hatch (FI-4).</item>
  <item>markerSource resolves at plan time (RFC-1498): a non-network origin warns in the step detail by kind, never by path, and execution reuses the planned value — one git call, no plan/execute drift.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 2 — pre-push guard mode, install steps pre-push + markers, FLOW-10</item>
  <item>RFC-1498: step 2 — network-only marker source

markerSource accepts only network-shaped origins — http/https/ssh/git schemes or the scp user-at-host form — and returns { source, rejectedOrigin }. A local path or file:// URL falls back to the repository directory basename with rejectedOrigin naming the kind (local-path or file-url), so no machine-local path is ever written into an extract repository marker; embedded credentials are still stripped from network URLs. flow.install resolves the source at plan time, stores it on the plan for the execute phase, and the markers step warns origin rejected (kind) — using the directory name, never printing the path. Tests AC-3 (local path and file:// rejected, basename used, path absent from the step detail) and AC-4 (scp URL kept verbatim, https credentials stripped). Also carries the KEY_DECISIONS compass notes for step 1's stray-branch rule.</item>
  <item>RFC-1498: step 3 — legacy-tags report in flow.install

listLegacyTags scans refs/tags in a single for-each-ref pass carrying objecttype and NUL-delimited contents: a tag whose name matches a line grammar (tagPrefix + strict semver) is pre-program when it is lightweight, or annotated but its body lacks the schema forge/release-tag@1 line. flow.install gains an informational legacy-tags plan step listing every such tag as name (kind) — never a refusal, nothing is deleted or rewritten; execution simply marks the step done. Tests AC-5 (a lightweight v1.2.2 and a schema-less annotated lib at 0.1.0 appear with their kinds) and AC-6 (installation proceeds and both tags remain). Compass metadata updated.</item>
  <item>RFC-1515: harden forge flow worktree lifecycle against vanished paths, forge-local state, dead-holder locks and generated drift</item>
  <item>ADR-0124: enable git rerere in flow-managed repositories</item>
  <history>RFC-1486, RFC-1488, RFC-1490</history>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type {
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
  ExecResult,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import {
  currentBranch,
  fileInTree,
  git,
  gitCommit,
  isBare,
  isUnborn,
  requireGit,
  revListHasSubject,
  statusTracked,
  topLevel,
  worktreeList,
  configGet,
  branchExists,
  ensureRerere,
  revListCount,
} from "../git.ts";
import {
  ADOPTION_COMMIT_SUBJECT,
  GUARD_BEGIN_MARKER,
  GUARD_END_MARKER,
  GUARD_FILE,
  guardFileMatches,
  mergeManagedBlock,
  mergeManagedBlockForMode,
  PRECOMMIT_FILE,
  PREMERGE_FILE,
  PREPUSH_FILE,
  readGuardAsset,
  renderManagedHook,
  renderManagedPreCommit,
} from "../guard-files.ts";
import {
  MARKER_FILE,
  markerContent,
  markerSource,
  missingLineMarkers,
  type LineMarker,
  type RejectedOriginKind,
} from "../markers.ts";
import { detectRepoKind } from "../repo-kind.ts";
import {
  discoverReleaseLines,
  readLineVersionFile,
} from "../release-lines.ts";
import { listLegacyTags, listLineTags, releaseTagAnnotation, writeReleaseTag } from "../release-tags.ts";
import { compareVersions, parseVersion } from "../semver.ts";
import { collectFlowCheck, type FlowCheckData } from "./flow-check.ts";

export interface InstallStepReport {
  step:
    | "detect"
    | "primary"
    | "develop"
    | "hooksPath"
    | "rerere"
    | "checkout"
    | "guard"
    | "pre-commit"
    | "pre-merge-commit"
    | "pre-push"
    | "markers"
    | "commit"
    | "tags"
    | "legacy-tags"
    | "report";
  status: "planned" | "done" | "skipped" | "refused" | "failed";
  detail?: string;
}

type DevelopAction =
  | { kind: "create-at-main" }
  | { kind: "branch-f"; count: number }
  | { kind: "merge-ff"; worktree: string; count: number }
  | { kind: "adopt-unborn" }
  | { kind: "already-equal" };

type PreCommitChange = "create" | "insert" | "replace" | "identical";

export interface InstallPlan {
  repoRoot: string;
  primary: string;
  repoKind: "governed";
  steps: InstallStepReport[];
  refusal: Diagnostic | null;
  developAction: DevelopAction;
  hooksPathAction: "set" | "already";
  rerereAction: "set" | "already";
  checkoutAction: "switch" | "already";
  guardChange: "write" | "identical";
  /** hooks/flow-guard.sh already exists in the commit's parent ref. */
  guardCommitted: boolean;
  preCommitChange: PreCommitChange;
  /** hooks/pre-commit already exists in the commit's parent ref. */
  preCommitCommitted: boolean;
  preMergeChange: PreCommitChange;
  /** hooks/pre-merge-commit already exists in the commit's parent ref. */
  preMergeCommitted: boolean;
  prePushChange: PreCommitChange;
  /** hooks/pre-push already exists in the commit's parent ref. */
  prePushCommitted: boolean;
  /** Package-line dirs lacking a valid forge.generated.yaml (RFC-1491). */
  markerPlans: LineMarker[];
  /**
   * RFC-1498: the marker `source` resolved at plan time — a network origin
   * URL, or the directory basename when origin is absent or non-network
   * (rejectedOrigin names the kind, never the path).
   */
  markerSource: { source: string; rejectedOrigin: RejectedOriginKind | null };
  /** Baseline release tags the execute phase creates (RFC-1488 step 8.5). */
  tagPlans: TagPlan[];
}

export interface TagPlan {
  line: string;
  /** Full tag name, e.g. v6.444.0 or forge@9.0.0. */
  tag: string;
  version: string;
  /** Commit the tag points at — the commit that introduced the version. */
  commit: string;
  /** Previous tag name of the line, or null. */
  previous: string | null;
}

function refusalDiagnostic(ruleId: string, message: string, fixHint: string): Diagnostic {
  return { ruleId, severity: "error", message, fixHint };
}

/**
 * Plan phase — RFC steps 1–5 preconditions plus the step-6/7 diffs. Never
 * mutates; every FLOW-ADOPT refusal is decided here.
 */
export async function planInstall(repoRoot: string, io: WorkspaceIO): Promise<InstallPlan> {
  const steps: InstallStepReport[] = [];
  const refuse = (step: InstallStepReport["step"], diagnostic: Diagnostic): InstallPlan => {
    steps.push({ step, status: "refused", detail: diagnostic.message });
    return {
      repoRoot,
      primary: repoRoot,
      repoKind: "governed",
      steps,
      refusal: diagnostic,
      developAction: { kind: "already-equal" },
      hooksPathAction: "already",
      rerereAction: "already",
      checkoutAction: "already",
      guardChange: "identical",
      guardCommitted: false,
      preCommitChange: "identical",
      preCommitCommitted: false,
      preMergeChange: "identical",
      preMergeCommitted: false,
      prePushChange: "identical",
      prePushCommitted: false,
      markerPlans: [],
      markerSource: { source: "", rejectedOrigin: null },
      tagPlans: [],
    };
  };

  // 1. detect — only governed repositories are adopted.
  const detection = await detectRepoKind(repoRoot, io);
  if (!detection.ok) {
    return refuse(
      "detect",
      refusalDiagnostic(
        "FLOW-ADOPT-05",
        `${detection.detail} — the repository is not adoptable`,
        "fix forge.generated.yaml to satisfy forge/generated@1 or remove it",
      ),
    );
  }
  if (detection.repoKind.kind !== "governed") {
    return refuse(
      "detect",
      refusalDiagnostic(
        "FLOW-ADOPT-05",
        `repository is ${detection.repoKind.kind}, not governed — only repositories with forge.yaml and no generated marker are adopted`,
        "adopt the fixed branch model in a governed repository",
      ),
    );
  }
  steps.push({ step: "detect", status: "done", detail: "governed repository" });

  if (await isBare(repoRoot, io)) {
    return refuse(
      "detect",
      refusalDiagnostic(
        "FLOW-ADOPT-05",
        "the repository is bare — flow.install adopts working repositories with a primary worktree",
        "run flow.install inside a non-bare clone of the repository",
      ),
    );
  }

  // 2. primary — the primary worktree must have no tracked modifications.
  const worktrees = await worktreeList(repoRoot, io);
  const primary = worktrees[0]?.path ?? repoRoot;
  const dirty = (await statusTracked(primary, io)).entries;
  if (dirty.length > 0) {
    return refuse(
      "primary",
      refusalDiagnostic(
        "FLOW-ADOPT-03",
        `primary worktree has tracked modifications: ${dirty.join(", ")}`,
        `commit or stash the tracked changes in ${primary}, then re-run`,
      ),
    );
  }
  steps.push({ step: "primary", status: "done", detail: `clean: ${primary}` });

  // Adoption state. Once flow.install has run, develop being ahead of main is
  // the model's normal state (the adoption commit and later integrated work
  // live there); the FLOW-ADOPT-01 leveling refusal only guards the
  // not-yet-adopted bootstrap. Two committed-state signals mark a previous
  // adoption: core.hooksPath === "hooks" (only install sets it), or the
  // adoption-commit subject on develop (survives hooksPath drift). Working-
  // tree guard bytes are deliberately NOT a signal — a drifted guard is the
  // state the remedy re-runs install to repair.
  const earlyHooksPath = await configGet(repoRoot, io, "core.hooksPath");

  // 3. develop — resolve its shape relative to main (or an unborn HEAD).
  const developExists = await branchExists(repoRoot, io, "develop");
  const mainExists = await branchExists(repoRoot, io, "main");
  const adoptedBefore =
    earlyHooksPath === "hooks" ||
    (developExists &&
      (await revListHasSubject(repoRoot, io, "develop", ADOPTION_COMMIT_SUBJECT)));
  let developAction: DevelopAction | undefined;
  {
    if (!mainExists && !developExists) {
      if (!(await isUnborn(repoRoot, io))) {
        return refuse(
          "develop",
          refusalDiagnostic(
            "FLOW-ADOPT-06",
            "repository has commits but no 'main' branch",
            "rename the default branch to main first",
          ),
        );
      }
      developAction = { kind: "adopt-unborn" };
      steps.push({ step: "develop", status: "planned", detail: "point unborn HEAD at develop" });
    } else if (!mainExists) {
      return refuse(
        "develop",
        refusalDiagnostic(
          "FLOW-ADOPT-06",
          "repository has commits but no 'main' branch",
          "rename the default branch to main first",
        ),
      );
    } else if (!developExists) {
      developAction = { kind: "create-at-main" };
      steps.push({ step: "develop", status: "planned", detail: "create develop at main" });
    } else {
      const devAhead = await revListCount(repoRoot, io, "main..develop");
      if (devAhead > 0) {
        if (adoptedBefore) {
          developAction = { kind: "already-equal" };
          steps.push({
            step: "develop",
            status: "planned",
            detail: `already adopted — develop is ${devAhead} commit(s) ahead of main (normal state)`,
          });
        } else {
          const mainAhead = await revListCount(repoRoot, io, "develop..main");
          return refuse(
            "develop",
            refusalDiagnostic(
              "FLOW-ADOPT-01",
              `develop has ${devAhead} commit(s) that are not in main (main is ${mainAhead} ahead) — the fixed model needs develop to fast-forward to main, not to diverge`,
              "rebase or merge develop's commits through an auto branch first",
            ),
          );
        }
      } else {
        const mainAhead = await revListCount(repoRoot, io, "develop..main");
        if (mainAhead === 0) {
          developAction = { kind: "already-equal" };
          steps.push({ step: "develop", status: "planned", detail: "develop already equals main" });
        } else {
          const devWorktree = worktrees.find((w) => w.branch === "develop");
          if (devWorktree) {
            const devDirty = (await statusTracked(devWorktree.path, io)).entries;
            if (devDirty.length > 0) {
              return refuse(
                "develop",
                refusalDiagnostic(
                  "FLOW-ADOPT-04",
                  `develop is checked out in worktree ${devWorktree.path} which has tracked modifications: ${devDirty.join(", ")}`,
                  "commit or stash that worktree's tracked changes, then re-run",
                ),
              );
            }
            developAction = { kind: "merge-ff", worktree: devWorktree.path, count: mainAhead };
            steps.push({
              step: "develop",
              status: "planned",
              detail: `fast-forward develop ${mainAhead} commit(s) to main inside ${devWorktree.path}`,
            });
          } else {
            developAction = { kind: "branch-f", count: mainAhead };
            steps.push({
              step: "develop",
              status: "planned",
              detail: `fast-forward develop ${mainAhead} commit(s) to main`,
            });
          }
        }
      }
    }
  }

  if (developAction === undefined) {
    throw new Error("flow.install: develop shape unresolved — internal error");
  }

  // 4. hooksPath — shared repository config, never --worktree.
  const hooksPath = earlyHooksPath;
  let hooksPathAction: InstallPlan["hooksPathAction"];
  if (hooksPath === null) {
    hooksPathAction = "set";
    steps.push({ step: "hooksPath", status: "planned", detail: "set core.hooksPath to 'hooks'" });
  } else if (hooksPath === "hooks") {
    hooksPathAction = "already";
    steps.push({ step: "hooksPath", status: "planned", detail: "core.hooksPath already 'hooks'" });
  } else {
    return refuse(
      "hooksPath",
      refusalDiagnostic(
        "FLOW-ADOPT-02",
        `core.hooksPath is '${hooksPath}', expected 'hooks' or unset`,
        `repoint core.hooksPath to 'hooks' and move existing hooks under hooks/`,
      ),
    );
  }

  // 4b. rerere — ADR-0124: shared repository config, never --worktree.
  const rerereEnabled = await configGet(repoRoot, io, "rerere.enabled");
  const rerereAutoupdate = await configGet(repoRoot, io, "rerere.autoupdate");
  let rerereAction: InstallPlan["rerereAction"];
  if (rerereEnabled === "true" && rerereAutoupdate === "true") {
    rerereAction = "already";
    steps.push({ step: "rerere", status: "planned", detail: "rerere.enabled/.autoupdate already true" });
  } else {
    rerereAction = "set";
    steps.push({ step: "rerere", status: "planned", detail: "set rerere.enabled and rerere.autoupdate to true" });
  }

  // 5. checkout — the primary must be on main or develop.
  const primaryBranch = await currentBranch(primary, io);
  let checkoutAction: InstallPlan["checkoutAction"];
  if (primaryBranch === "develop" || developAction.kind === "adopt-unborn") {
    checkoutAction = "already";
    steps.push({
      step: "checkout",
      status: "planned",
      detail:
        developAction.kind === "adopt-unborn"
          ? "HEAD will already point at unborn develop"
          : "primary already on develop",
    });
  } else if (primaryBranch === "main") {
    const devElsewhere = worktrees.find((w) => w.branch === "develop" && w.path !== primary);
    if (devElsewhere) {
      return refuse(
        "checkout",
        refusalDiagnostic(
          "FLOW-ADOPT-08",
          `primary is on 'main' but develop is already checked out in worktree ${devElsewhere.path} — git cannot check it out twice`,
          `run flow.install from ${devElsewhere.path}, or detach that worktree first`,
        ),
      );
    }
    checkoutAction = "switch";
    steps.push({ step: "checkout", status: "planned", detail: "switch primary to develop" });
  } else {
    return refuse(
      "checkout",
      refusalDiagnostic(
        "FLOW-ADOPT-08",
        `primary worktree is on branch '${primaryBranch ?? "(detached)"}', expected 'main' or 'develop'`,
        `switch the primary worktree to main first: git -C ${primary} switch main`,
      ),
    );
  }

  // Steps 6/7 diffs — computed now so --dry-run reports real intent. The
  // parent ref the adoption commit lands on: post-leveling content is main's
  // for create/ff actions; an already-equal develop is never leveled, so the
  // committed-state check must look there (RFC-1487 worktrees check out
  // committed content — byte-exact-but-uncommitted hook files still need the
  // adoption commit).
  const hookBaseRef =
    developAction.kind === "adopt-unborn"
      ? null
      : developAction.kind === "already-equal" && developExists
        ? "develop"
        : "main";

  const guardIdentical = await guardFileMatches(async () =>
    (await io.exists(join(primary, GUARD_FILE)))
      ? io.readFile(join(primary, GUARD_FILE))
      : null,
  );
  const guardCommitted =
    hookBaseRef !== null && (await fileInTree(repoRoot, io, hookBaseRef, GUARD_FILE));
  const guardChange: InstallPlan["guardChange"] =
    guardIdentical && guardCommitted ? "identical" : "write";
  steps.push({
    step: "guard",
    status: "planned",
    detail: guardIdentical
      ? guardCommitted
        ? "hooks/flow-guard.sh already matches the asset"
        : "hooks/flow-guard.sh matches the asset but is uncommitted — land it on develop"
      : "install the fixed branch model guard as hooks/flow-guard.sh (0755)",
  });

  const preCommitPath = join(primary, PRECOMMIT_FILE);
  const preCommitExisting = (await io.exists(preCommitPath))
    ? await io.readFile(preCommitPath)
    : null;
  const preCommitCommitted =
    hookBaseRef !== null && (await fileInTree(repoRoot, io, hookBaseRef, PRECOMMIT_FILE));
  let preCommitChange: PreCommitChange;
  if (preCommitExisting === null) {
    preCommitChange = "create";
  } else if (mergeManagedBlock(preCommitExisting) === null) {
    preCommitChange = "identical";
  } else {
    // Marker span present but block differs → merge replaces between the
    // markers; absent/dangling markers → insert after the shebang.
    const beginIdx = preCommitExisting.indexOf(GUARD_BEGIN_MARKER);
    const endIdx = preCommitExisting.indexOf(GUARD_END_MARKER);
    preCommitChange = beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx ? "replace" : "insert";
  }
  steps.push({
    step: "pre-commit",
    status: "planned",
    detail:
      preCommitChange === "identical"
        ? preCommitCommitted
          ? "hooks/pre-commit already carries the managed block"
          : "hooks/pre-commit carries the managed block but is uncommitted — land it on develop"
        : `${preCommitChange} managed block in hooks/pre-commit`,
  });

  const preMergePath = join(primary, PREMERGE_FILE);
  const preMergeExisting = (await io.exists(preMergePath))
    ? await io.readFile(preMergePath)
    : null;
  const preMergeCommitted =
    hookBaseRef !== null && (await fileInTree(repoRoot, io, hookBaseRef, PREMERGE_FILE));
  let preMergeChange: PreCommitChange;
  if (preMergeExisting === null) {
    preMergeChange = "create";
  } else if (mergeManagedBlockForMode(preMergeExisting, "pre-merge-commit") === null) {
    preMergeChange = "identical";
  } else {
    const beginIdx = preMergeExisting.indexOf(GUARD_BEGIN_MARKER);
    const endIdx = preMergeExisting.indexOf(GUARD_END_MARKER);
    preMergeChange = beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx ? "replace" : "insert";
  }
  steps.push({
    step: "pre-merge-commit",
    status: "planned",
    detail:
      preMergeChange === "identical"
        ? preMergeCommitted
          ? "hooks/pre-merge-commit already carries the managed block"
          : "hooks/pre-merge-commit carries the managed block but is uncommitted — land it on develop"
        : `${preMergeChange} managed block in hooks/pre-merge-commit`,
  });

  const prePushPath = join(primary, PREPUSH_FILE);
  const prePushExisting = (await io.exists(prePushPath))
    ? await io.readFile(prePushPath)
    : null;
  const prePushCommitted =
    hookBaseRef !== null && (await fileInTree(repoRoot, io, hookBaseRef, PREPUSH_FILE));
  let prePushChange: PreCommitChange;
  if (prePushExisting === null) {
    prePushChange = "create";
  } else if (mergeManagedBlockForMode(prePushExisting, "pre-push") === null) {
    prePushChange = "identical";
  } else {
    const beginIdx = prePushExisting.indexOf(GUARD_BEGIN_MARKER);
    const endIdx = prePushExisting.indexOf(GUARD_END_MARKER);
    prePushChange = beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx ? "replace" : "insert";
  }
  steps.push({
    step: "pre-push",
    status: "planned",
    detail:
      prePushChange === "identical"
        ? prePushCommitted
          ? "hooks/pre-push already carries the managed block"
          : "hooks/pre-push carries the managed block but is uncommitted — land it on develop"
        : `${prePushChange} managed block in hooks/pre-push`,
  });

  // markers (RFC-1491) — every package line gets a forge.generated.yaml the
  // extract copies into its repository; the repo line never carries one.
  // RFC-1498: the source is resolved at plan time so the step can warn when
  // origin is not a network URL — the warning names the kind, never the path.
  const marker = await markerSource(repoRoot, io);
  const { markers: markerPlans } = await missingLineMarkers(repoRoot, io);
  steps.push({
    step: "markers",
    status: "planned",
    detail:
      (markerPlans.length > 0
        ? `marker(s): ${markerPlans.map((m) => join(m.dir, MARKER_FILE)).join(", ")}`
        : "every package line already carries a valid marker") +
      (marker.rejectedOrigin !== null
        ? ` — origin rejected (${marker.rejectedOrigin}), using the directory name`
        : ""),
  });

  const commitNeeded =
    guardChange === "write" ||
    !guardCommitted ||
    preCommitChange !== "identical" ||
    !preCommitCommitted ||
    preMergeChange !== "identical" ||
    !preMergeCommitted ||
    prePushChange !== "identical" ||
    !prePushCommitted ||
    markerPlans.length > 0;
  steps.push({
    step: "commit",
    status: "planned",
    detail: commitNeeded
      ? `adoption commit '${ADOPTION_COMMIT_SUBJECT}' on develop`
      : "hook files unchanged — no adoption commit",
  });

  // 8.5 tags (RFC-1488) — baseline every line whose version file V outruns
  // its last reachable annotated tag T. V == T → skipped; V < T → refuse
  // FLOW-ADOPT-07 (never tag backwards); a baseline commit that is not an
  // ancestor of main → FLOW-ADOPT-07. Evaluated in the plan phase so a
  // refusal leaves no tag behind.
  const tagPlans: TagPlan[] = [];
  let legacyTags: Awaited<ReturnType<typeof listLegacyTags>> = [];
  if (!mainExists) {
    steps.push({
      step: "tags",
      status: "planned",
      detail: "no main branch — baseline tags deferred until the repository has commits",
    });
  } else {
    const { lines, diagnostics: discoveryDiagnostics } = await discoverReleaseLines(repoRoot, io);
    const collision = discoveryDiagnostics.find((d) => d.severity === "error");
    if (collision) {
      return refuse("tags", collision);
    }
    for (const line of lines) {
      const versionText = await readLineVersionFile(repoRoot, line, io);
      if (versionText === null) continue; // no version file value — nothing to tag
      const V = parseVersion(versionText);
      if (V === null) {
        return refuse(
          "tags",
          refusalDiagnostic(
            "FLOW-ADOPT-07",
            `release line '${line.id}' carries an unparsable version '${versionText}' in ${line.versionFile} — release tags are strict X.Y.Z`,
            `fix ${line.versionFile} to a strict X.Y.Z version`,
          ),
        );
      }
      const tags = await listLineTags(repoRoot, line, io);
      const T = tags.lastTag;
      const cmp = T === null ? 1 : compareVersions(V, T.version);
      if (cmp === 0) continue; // tag already matches the version file
      if (cmp < 0) {
        return refuse(
          "tags",
          refusalDiagnostic(
            "FLOW-ADOPT-07",
            `release line '${line.id}' version file says ${versionText} but its last tag is ${T!.name} — never tag backwards`,
            `raise ${line.versionFile} above ${T!.name}, or fix the wrong tag manually`,
          ),
        );
      }
      const commit = await findVersionCommit(repoRoot, line.versionFile!, versionText, io);
      if (commit === null) {
        return refuse(
          "tags",
          refusalDiagnostic(
            "FLOW-ADOPT-07",
            `release line '${line.id}': could not find the commit that introduced version ${versionText} in ${line.versionFile}`,
            `commit the version change first, or create the baseline tag ${line.tagPrefix}${versionText} manually`,
          ),
        );
      }
      const ancestor = await git(repoRoot, io, ["merge-base", "--is-ancestor", commit, "main"]);
      if (ancestor.exitCode !== 0) {
        return refuse(
          "tags",
          refusalDiagnostic(
            "FLOW-ADOPT-07",
            `release line '${line.id}': commit ${commit.slice(0, 9)} introducing version ${versionText} is not an ancestor of main`,
            "land the version change on main first",
          ),
        );
      }
      tagPlans.push({
        line: line.id,
        tag: `${line.tagPrefix}${versionText}`,
        version: versionText,
        commit,
        previous: T?.name ?? null,
      });
    }
    steps.push({
      step: "tags",
      status: "planned",
      detail:
        tagPlans.length > 0
          ? `baseline tag(s): ${tagPlans.map((t) => `${t.tag}@${t.commit.slice(0, 9)}`).join(", ")}`
          : "no baseline tags needed",
    });
    legacyTags = await listLegacyTags(repoRoot, lines, io);
  }
  // RFC-1498 — pre-program tags stay, but the operator sees them: every
  // tag matching a line grammar that the release-line reader ignores
  // (lightweight) or accepts without the forge/release-tag@1 schema.
  // Informational — never a refusal.
  steps.push({
    step: "legacy-tags",
    status: "planned",
    detail:
      legacyTags.length > 0
        ? `pre-program tag(s): ${legacyTags.map((t) => `${t.name} (${t.kind})`).join(", ")}`
        : "none",
  });
  steps.push({ step: "report", status: "planned", detail: "embed flow.check diagnostics" });

  return {
    repoRoot,
    primary,
    repoKind: "governed",
    steps,
    refusal: null,
    developAction,
    hooksPathAction,
    rerereAction,
    checkoutAction,
    guardChange,
    guardCommitted,
    preCommitChange,
    preCommitCommitted,
    preMergeChange,
    preMergeCommitted,
    prePushChange,
    prePushCommitted,
    markerPlans,
    markerSource: marker,
    tagPlans,
  };
}

/**
 * The commit that introduced `version` in `versionFile` — pickaxe on the
 * canonical `"version": "X.Y.Z"` formatting first, then a `git log -p` scan
 * for the newest commit adding a normalized-matching line (audit G2: files
 * formatted without the space after the colon defeat -S).
 */
async function findVersionCommit(
  repoRoot: string,
  versionFile: string,
  version: string,
  io: WorkspaceIO,
): Promise<string | null> {
  const needle = `"version": "${version}"`;
  const pick = await git(repoRoot, io, [
    "log",
    "-1",
    "--format=%H",
    `-S${needle}`,
    "--",
    versionFile,
  ]);
  if (pick.exitCode === 0 && pick.stdout.trim().length > 0) {
    return pick.stdout.trim();
  }
  const log = await git(repoRoot, io, ["log", "-p", "--format=%H", "--", versionFile]);
  if (log.exitCode !== 0) return null;
  const normalizedNeedle = needle.replace(/\s+/g, "");
  let commit: string | null = null;
  for (const raw of log.stdout.split("\n")) {
    const line = raw.trimEnd();
    if (/^[0-9a-f]{40}$/.test(line)) {
      commit = line;
      continue;
    }
    if (
      commit !== null &&
      line.startsWith("+") &&
      !line.startsWith("+++") &&
      line.slice(1).replace(/\s+/g, "").includes(normalizedNeedle)
    ) {
      return commit;
    }
  }
  return null;
}

function setStep(
  plan: InstallPlan,
  step: InstallStepReport["step"],
  status: InstallStepReport["status"],
  detail?: string,
): void {
  const entry = plan.steps.find((s) => s.step === step);
  if (entry) {
    entry.status = status;
    if (detail !== undefined) entry.detail = detail;
  }
}

// Executable bits are POSIX filesystem semantics — on Windows the index mode
// is set by `git add --chmod=+x` instead, and `chmod` lives in Git's usr/bin
// which is not guaranteed on PATH (spawn ENOENT aborts the install).
async function chmodHook(io: WorkspaceIO, filePath: string): Promise<ExecResult> {
  if (process.platform === "win32") return { exitCode: 0, stdout: "", stderr: "" };
  return io.exec("chmod", ["0755", filePath]);
}

/**
 * Execute phase — steps 3–9 in order on an approved plan. A failing step
 * reports status "failed" into steps[] and every still-planned later step is
 * marked "skipped" — the step trail stays complete for the report (DNA-106).
 */
export async function executeInstall(
  plan: InstallPlan,
  io: WorkspaceIO,
): Promise<{ check: FlowCheckData | null; checkDiagnostics: Diagnostic[] }> {
  const { repoRoot, primary } = plan;
  const STEP_ORDER: InstallStepReport["step"][] = [
    "develop",
    "hooksPath",
    "checkout",
    "guard",
    "pre-commit",
    "pre-merge-commit",
    "pre-push",
    "markers",
    "commit",
    "tags",
    "legacy-tags",
    "report",
  ];
  const failStep = (
    step: InstallStepReport["step"],
    detail: string,
  ): { check: FlowCheckData | null; checkDiagnostics: Diagnostic[] } => {
    setStep(plan, step, "failed", detail);
    const idx = STEP_ORDER.indexOf(step);
    for (const s of plan.steps) {
      if (STEP_ORDER.indexOf(s.step) > idx && s.status === "planned") {
        setStep(plan, s.step, "skipped");
      }
    }
    return { check: null, checkDiagnostics: [] };
  };

  // 3. develop
  switch (plan.developAction.kind) {
    case "create-at-main": {
      const r = await git(repoRoot, io, ["branch", "develop", "main"]);
      if (r.exitCode !== 0) {
        return failStep("develop", `git branch develop main failed: ${r.stderr.trim()}`);
      }
      setStep(plan, "develop", "done", "created develop at main");
      break;
    }
    case "branch-f": {
      const r = await git(repoRoot, io, ["branch", "-f", "develop", "main"]);
      if (r.exitCode !== 0) {
        return failStep("develop", `git branch -f develop main failed: ${r.stderr.trim()}`);
      }
      setStep(
        plan,
        "develop",
        "done",
        `fast-forwarded develop ${plan.developAction.count} commit(s) to main`,
      );
      break;
    }
    case "merge-ff": {
      const r = await git(plan.developAction.worktree, io, ["merge", "--ff-only", "main"]);
      if (r.exitCode !== 0) {
        return failStep(
          "develop",
          `git -C ${plan.developAction.worktree} merge --ff-only main failed: ${r.stderr.trim()}`,
        );
      }
      setStep(
        plan,
        "develop",
        "done",
        `fast-forwarded develop ${plan.developAction.count} commit(s) to main inside ${plan.developAction.worktree}`,
      );
      break;
    }
    case "adopt-unborn": {
      const r = await git(repoRoot, io, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
      if (r.exitCode !== 0) {
        return failStep(
          "develop",
          `git symbolic-ref HEAD refs/heads/develop failed: ${r.stderr.trim()}`,
        );
      }
      setStep(plan, "develop", "done", "pointed unborn HEAD at develop");
      break;
    }
    case "already-equal": {
      const planned = plan.steps.find((s) => s.step === "develop");
      setStep(plan, "develop", "skipped", planned?.detail ?? "develop already equals main");
      break;
    }
  }

  // 4. hooksPath — shared config only.
  if (plan.hooksPathAction === "set") {
    const r = await git(repoRoot, io, ["config", "core.hooksPath", "hooks"]);
    if (r.exitCode !== 0) {
      return failStep("hooksPath", `git config core.hooksPath hooks failed: ${r.stderr.trim()}`);
    }
    setStep(plan, "hooksPath", "done", "core.hooksPath set to 'hooks'");
  } else {
    setStep(plan, "hooksPath", "skipped", "core.hooksPath already 'hooks'");
  }

  // 4b. rerere — ADR-0124 shared config repair.
  if (plan.rerereAction === "set") {
    const failures = await ensureRerere(repoRoot, io);
    if (failures.length > 0) {
      return failStep("rerere", failures.join("; "));
    }
    setStep(plan, "rerere", "done", "rerere.enabled and rerere.autoupdate set to true");
  } else {
    setStep(plan, "rerere", "skipped", "rerere.enabled/.autoupdate already true");
  }

  // 5. checkout
  if (plan.checkoutAction === "switch") {
    const r = await git(primary, io, ["switch", "develop"]);
    if (r.exitCode !== 0) {
      return failStep("checkout", `git -C ${primary} switch develop failed: ${r.stderr.trim()}`);
    }
    setStep(plan, "checkout", "done", "primary switched to develop");
  } else {
    setStep(plan, "checkout", "skipped");
  }

  // 6. guard — byte copy of the shipped asset, mode 0755. An already
  // byte-exact but uncommitted file still needs staging for the adoption
  // commit (worktrees check out committed content).
  let hooksNeedCommit = false;
  const guardPath = join(primary, GUARD_FILE);
  if (plan.guardChange === "write") {
    try {
      await io.mkdir(join(primary, "hooks"));
      await io.writeFile(guardPath, readGuardAsset());
    } catch (err) {
      return failStep("guard", `writing ${GUARD_FILE} failed: ${(err as Error).message}`);
    }
    const chmod = await chmodHook(io, guardPath);
    if (chmod.exitCode !== 0) {
      return failStep("guard", `chmod 0755 ${GUARD_FILE} failed: ${chmod.stderr.trim()}`);
    }
    hooksNeedCommit = true;
    setStep(plan, "guard", "done", "wrote hooks/flow-guard.sh (0755)");
  } else if (!plan.guardCommitted) {
    hooksNeedCommit = true;
    setStep(plan, "guard", "done", "hooks/flow-guard.sh already byte-exact — staged for commit");
  } else {
    setStep(plan, "guard", "skipped", "hooks/flow-guard.sh already matches the asset");
  }

  // 7. pre-commit — create, insert after the shebang, or replace the block.
  const preCommitPath = join(primary, PRECOMMIT_FILE);
  if (plan.preCommitChange === "identical") {
    if (!plan.preCommitCommitted) {
      hooksNeedCommit = true;
      setStep(plan, "pre-commit", "done", "managed block already correct — staged for commit");
    } else {
      setStep(plan, "pre-commit", "skipped", "managed block already present");
    }
  } else {
    const existing = (await io.exists(preCommitPath)) ? await io.readFile(preCommitPath) : null;
    const next =
      existing === null ? renderManagedPreCommit() : mergeManagedBlock(existing);
    if (next === null) {
      if (!plan.preCommitCommitted) {
        hooksNeedCommit = true;
        setStep(plan, "pre-commit", "done", "managed block already correct — staged for commit");
      } else {
        setStep(plan, "pre-commit", "skipped", "managed block already present");
      }
    } else {
      try {
        await io.mkdir(join(primary, "hooks"));
        await io.writeFile(preCommitPath, next.endsWith("\n") ? next : `${next}\n`);
      } catch (err) {
        return failStep(
          "pre-commit",
          `writing ${PRECOMMIT_FILE} failed: ${(err as Error).message}`,
        );
      }
      const chmod = await chmodHook(io, preCommitPath);
      if (chmod.exitCode !== 0) {
        return failStep("pre-commit", `chmod 0755 ${PRECOMMIT_FILE} failed: ${chmod.stderr.trim()}`);
      }
      hooksNeedCommit = true;
      setStep(plan, "pre-commit", "done", `${plan.preCommitChange}d managed block in hooks/pre-commit`);
    }
  }

  // 7.5 pre-merge-commit — same managed-block mechanics, pre-merge-commit mode.
  const preMergePath = join(primary, PREMERGE_FILE);
  if (plan.preMergeChange === "identical") {
    if (!plan.preMergeCommitted) {
      hooksNeedCommit = true;
      setStep(plan, "pre-merge-commit", "done", "managed block already correct — staged for commit");
    } else {
      setStep(plan, "pre-merge-commit", "skipped", "managed block already present");
    }
  } else {
    const existing = (await io.exists(preMergePath)) ? await io.readFile(preMergePath) : null;
    const next =
      existing === null
        ? renderManagedHook("pre-merge-commit")
        : mergeManagedBlockForMode(existing, "pre-merge-commit");
    if (next === null) {
      if (!plan.preMergeCommitted) {
        hooksNeedCommit = true;
        setStep(plan, "pre-merge-commit", "done", "managed block already correct — staged for commit");
      } else {
        setStep(plan, "pre-merge-commit", "skipped", "managed block already present");
      }
    } else {
      try {
        await io.mkdir(join(primary, "hooks"));
        await io.writeFile(preMergePath, next.endsWith("\n") ? next : `${next}\n`);
      } catch (err) {
        return failStep(
          "pre-merge-commit",
          `writing ${PREMERGE_FILE} failed: ${(err as Error).message}`,
        );
      }
      const chmod = await chmodHook(io, preMergePath);
      if (chmod.exitCode !== 0) {
        return failStep("pre-merge-commit", `chmod 0755 ${PREMERGE_FILE} failed: ${chmod.stderr.trim()}`);
      }
      hooksNeedCommit = true;
      setStep(plan, "pre-merge-commit", "done", `${plan.preMergeChange}d managed block in hooks/pre-merge-commit`);
    }
  }

  // 7.7 pre-push — the RFC-1491 outbound mode.
  const prePushPath = join(primary, PREPUSH_FILE);
  if (plan.prePushChange === "identical") {
    if (!plan.prePushCommitted) {
      hooksNeedCommit = true;
      setStep(plan, "pre-push", "done", "managed block already correct — staged for commit");
    } else {
      setStep(plan, "pre-push", "skipped", "managed block already present");
    }
  } else {
    const existing = (await io.exists(prePushPath)) ? await io.readFile(prePushPath) : null;
    const next =
      existing === null
        ? renderManagedHook("pre-push")
        : mergeManagedBlockForMode(existing, "pre-push");
    if (next === null) {
      if (!plan.prePushCommitted) {
        hooksNeedCommit = true;
        setStep(plan, "pre-push", "done", "managed block already correct — staged for commit");
      } else {
        setStep(plan, "pre-push", "skipped", "managed block already present");
      }
    } else {
      try {
        await io.mkdir(join(primary, "hooks"));
        await io.writeFile(prePushPath, next.endsWith("\n") ? next : `${next}\n`);
      } catch (err) {
        return failStep(
          "pre-push",
          `writing ${PREPUSH_FILE} failed: ${(err as Error).message}`,
        );
      }
      const chmod = await chmodHook(io, prePushPath);
      if (chmod.exitCode !== 0) {
        return failStep("pre-push", `chmod 0755 ${PREPUSH_FILE} failed: ${chmod.stderr.trim()}`);
      }
      hooksNeedCommit = true;
      setStep(plan, "pre-push", "done", `${plan.prePushChange}d managed block in hooks/pre-push`);
    }
  }

  // 7.8 markers (RFC-1491) — forge.generated.yaml per package line so every
  // extract repository carries the generated marker.
  if (plan.markerPlans.length === 0) {
    setStep(plan, "markers", "skipped", "every package line already carries a valid marker");
  } else {
    const { source } = plan.markerSource;
    for (const m of plan.markerPlans) {
      try {
        await io.mkdir(join(primary, m.dir));
        await io.writeFile(join(primary, m.dir, MARKER_FILE), markerContent(`${source}#${m.dir}`));
      } catch (err) {
        return failStep("markers", `writing ${m.dir}/${MARKER_FILE} failed: ${(err as Error).message}`);
      }
    }
    hooksNeedCommit = true;
    setStep(plan, "markers", "done", `wrote ${plan.markerPlans.length} marker(s)`);
  }

  // 8. adoption commit — under FORGE_FLOW_OP=install, nothing else staged.
  if (hooksNeedCommit) {
    const markerPaths = plan.markerPlans.map((m) => join(m.dir, MARKER_FILE));
    // --chmod=+x on the hook scripts: Windows checkouts carry
    // core.fileMode=false, so a plain `git add` would record 100644 even
    // after chmod — the hook contracts (and git itself on POSIX checkouts)
    // require mode 100755 in the index. Markers stay plain adds.
    const addHooks = await git(primary, io, [
      "add",
      "--chmod=+x",
      GUARD_FILE,
      PRECOMMIT_FILE,
      PREMERGE_FILE,
      PREPUSH_FILE,
    ]);
    if (addHooks.exitCode !== 0) {
      return failStep("commit", `git add failed: ${addHooks.stderr.trim()}`);
    }
    if (markerPaths.length > 0) {
      const addMarkers = await git(primary, io, ["add", ...markerPaths]);
      if (addMarkers.exitCode !== 0) {
        return failStep("commit", `git add failed: ${addMarkers.stderr.trim()}`);
      }
    }
    const commit = await gitCommit(
      primary,
      io,
      ["commit", "-m", ADOPTION_COMMIT_SUBJECT],
      "install",
      { FORGE_FLOW_OP: "install" },
    );
    if (commit.exitCode !== 0) {
      return failStep("commit", `git commit failed: ${commit.stderr.trim()}`);
    }
    setStep(plan, "commit", "done", `committed '${ADOPTION_COMMIT_SUBJECT}' on develop`);
  } else {
    setStep(plan, "commit", "skipped", "hook files unchanged — nothing to commit");
  }

  // 8.5 tags (RFC-1488) — the baselines the plan phase approved. Tags are
  // local objects only; pushing them is the wave-2 outbound command.
  if (plan.tagPlans.length > 0) {
    for (const tagPlan of plan.tagPlans) {
      const r = await writeReleaseTag(repoRoot, io, {
        name: tagPlan.tag,
        target: tagPlan.commit,
        annotation: releaseTagAnnotation({
          tag: tagPlan.tag,
          line: tagPlan.line,
          version: tagPlan.version,
          level: "baseline",
          previous: tagPlan.previous,
          rfcs: [],
          fingerprints: {},
        }),
      });
      if (r.exitCode !== 0) {
        return failStep("tags", `git tag -a ${tagPlan.tag} failed: ${r.stderr.trim()}`);
      }
    }
    setStep(
      plan,
      "tags",
      "done",
      `created baseline tag(s): ${plan.tagPlans.map((t) => `${t.tag}@${t.commit.slice(0, 9)}`).join(", ")}`,
    );
  } else {
    setStep(plan, "tags", "skipped", "no baseline tags needed");
  }

  // legacy-tags (RFC-1498) — informational only: the plan phase already
  // listed them; execution changes nothing about existing tags.
  {
    const planned = plan.steps.find((s) => s.step === "legacy-tags");
    setStep(plan, "legacy-tags", "done", planned?.detail ?? "none");
  }

  // 9. report — the flow.check rule set, embedded.
  try {
    const outcome = await collectFlowCheck(repoRoot, io);
    setStep(plan, "report", "done", `${outcome.diagnostics.length} diagnostic(s) embedded`);
    return { check: outcome.data, checkDiagnostics: outcome.diagnostics };
  } catch (err) {
    return failStep("report", `flow.check failed: ${(err as Error).message}`);
  }
}

export interface FlowInstallData {
  repoKind: string;
  dryRun: boolean;
  steps: InstallStepReport[];
  check?: FlowCheckData | null;
  checkDiagnostics?: Diagnostic[];
}

export async function runFlowInstall(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowInstallData>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  const dryRun = context.dryRun || input.flags?.["dry-run"] === true;
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.install must run inside a git repository");
  }

  const plan = await planInstall(repoRoot, io);
  if (plan.refusal) {
    if (outputFormat === "pretty") {
      logger.error(`flow.install refused: ${plan.refusal.message}`);
    }
    return {
      data: {
        repoKind: "governed",
        dryRun,
        steps: plan.steps,
      },
      exitCode: 1,
      summary: `[flow.install] refused: ${plan.refusal.ruleId} ${plan.refusal.message}`,
    };
  }

  if (dryRun) {
    if (outputFormat === "pretty") {
      logger.section("flow.install (dry run)");
      for (const s of plan.steps) {
        logger.info(`  ${s.step}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`);
      }
    }
    return {
      data: { repoKind: plan.repoKind, dryRun: true, steps: plan.steps },
      exitCode: 0,
      summary: `[flow.install] dry run — ${plan.steps.length} step(s) planned, nothing changed`,
    };
  }

  const { check, checkDiagnostics } = await executeInstall(plan, io);
  const failedStep = plan.steps.find((s) => s.status === "failed");

  if (outputFormat === "pretty") {
    logger.section("flow.install");
    for (const s of plan.steps) {
      const line = `  ${s.step}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`;
      if (s.status === "failed") logger.error(line);
      else logger.info(line);
    }
  }

  return {
    data: {
      repoKind: plan.repoKind,
      dryRun: false,
      steps: plan.steps,
      check,
      checkDiagnostics,
    },
    exitCode: failedStep ? 1 : 0,
    summary: failedStep
      ? `[flow.install] failed at ${failedStep.step}: ${failedStep.detail}`
      : `[flow.install] adopted — ${plan.steps.filter((s) => s.status === "done").length} step(s) done, ${checkDiagnostics.length} check diagnostic(s)`,
  };
}
