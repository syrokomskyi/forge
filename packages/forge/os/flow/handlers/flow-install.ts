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
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 4 — flow.install two-phase adoption</item>
  <item>RFC-1486: step 4 — flow.install two-phase adoption + rerun-safe</item>
  <item>RFC-1486: final — guard-step detail names the fixed-branch-model guard install (AC-11 probe)</item>
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
  currentBranch,
  git,
  isBare,
  isUnborn,
  requireGit,
  statusTracked,
  topLevel,
  worktreeList,
  configGet,
  branchExists,
  revListCount,
} from "../git.ts";
import {
  ADOPTION_COMMIT_SUBJECT,
  GUARD_FILE,
  guardFileMatches,
  hasManagedBlock,
  mergeManagedBlock,
  PRECOMMIT_FILE,
  readGuardAsset,
  renderManagedPreCommit,
} from "../guard-files.ts";
import { detectRepoKind } from "../repo-kind.ts";
import { collectFlowCheck, type FlowCheckData } from "./flow-check.ts";

export interface InstallStepReport {
  step:
    | "detect"
    | "primary"
    | "develop"
    | "hooksPath"
    | "checkout"
    | "guard"
    | "pre-commit"
    | "commit"
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
  checkoutAction: "switch" | "already";
  guardChange: "write" | "identical";
  preCommitChange: PreCommitChange;
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
      checkoutAction: "already",
      guardChange: "identical",
      preCommitChange: "identical",
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
  const dirty = await statusTracked(primary, io);
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

  // Adoption state — all three FLOW-03 conditions hold. Once adopted, develop
  // being ahead of main is the model's normal state (the adoption commit and
  // later integrated work live there); the FLOW-ADOPT-01 leveling check only
  // guards the not-yet-adopted bootstrap.
  const earlyHooksPath = await configGet(repoRoot, io, "core.hooksPath");
  const earlyGuardOk = await guardFileMatches(async () =>
    (await io.exists(join(primary, GUARD_FILE))) ? io.readFile(join(primary, GUARD_FILE)) : null,
  );
  const earlyPreCommit = (await io.exists(join(primary, PRECOMMIT_FILE)))
    ? await io.readFile(join(primary, PRECOMMIT_FILE))
    : null;
  const alreadyAdopted =
    earlyHooksPath === "hooks" && earlyGuardOk && earlyPreCommit !== null &&
    hasManagedBlock(earlyPreCommit);

  // 3. develop — resolve its shape relative to main (or an unborn HEAD).
  const developExists = await branchExists(repoRoot, io, "develop");
  const mainExists = await branchExists(repoRoot, io, "main");
  let developAction: DevelopAction | undefined;
  if (alreadyAdopted && developExists) {
    const devAhead = await revListCount(repoRoot, io, "main..develop");
    if (devAhead > 0) {
      developAction = { kind: "already-equal" };
      steps.push({
        step: "develop",
        status: "planned",
        detail: `already adopted — develop is ${devAhead} commit(s) ahead of main (normal state)`,
      });
    }
  }
  if (developAction === undefined) {
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
      const mainAhead = await revListCount(repoRoot, io, "develop..main");
      if (mainAhead === 0) {
        developAction = { kind: "already-equal" };
        steps.push({ step: "develop", status: "planned", detail: "develop already equals main" });
      } else {
        const devWorktree = worktrees.find((w) => w.branch === "develop");
        if (devWorktree) {
          const devDirty = await statusTracked(devWorktree.path, io);
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

  if (developAction === undefined) {
    throw new Error("flow.install: develop shape unresolved — internal error");
  }

  // 4. hooksPath — shared repository config, never --worktree.
  const hooksPath = await configGet(repoRoot, io, "core.hooksPath");
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

  // Steps 6/7 diffs — computed now so --dry-run reports real intent.
  const guardIdentical = await guardFileMatches(async () =>
    (await io.exists(join(primary, GUARD_FILE)))
      ? io.readFile(join(primary, GUARD_FILE))
      : null,
  );
  const guardChange: InstallPlan["guardChange"] = guardIdentical ? "identical" : "write";
  steps.push({
    step: "guard",
    status: "planned",
    detail: guardIdentical
      ? "hooks/flow-guard.sh already matches the asset"
      : "install the fixed branch model guard as hooks/flow-guard.sh (0755)",
  });

  const preCommitPath = join(primary, PRECOMMIT_FILE);
  const preCommitExisting = (await io.exists(preCommitPath))
    ? await io.readFile(preCommitPath)
    : null;
  let preCommitChange: PreCommitChange;
  if (preCommitExisting === null) preCommitChange = "create";
  else if (hasManagedBlock(preCommitExisting)) {
    preCommitChange = mergeManagedBlock(preCommitExisting) === null ? "identical" : "replace";
  } else {
    preCommitChange = "insert";
  }
  steps.push({
    step: "pre-commit",
    status: "planned",
    detail:
      preCommitChange === "identical"
        ? "hooks/pre-commit already carries the managed block"
        : `${preCommitChange} managed block in hooks/pre-commit`,
  });

  const commitNeeded = guardChange === "write" || preCommitChange !== "identical";
  steps.push({
    step: "commit",
    status: "planned",
    detail: commitNeeded
      ? `adoption commit '${ADOPTION_COMMIT_SUBJECT}' on develop`
      : "hook files unchanged — no adoption commit",
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
    checkoutAction,
    guardChange,
    preCommitChange,
  };
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

/**
 * Execute phase — steps 3–9 in order on an approved plan. Returns the step
 * the commit failed at (status "failed") or null on success.
 */
export async function executeInstall(
  plan: InstallPlan,
  io: WorkspaceIO,
): Promise<{ check: FlowCheckData | null; checkDiagnostics: Diagnostic[] }> {
  const { repoRoot, primary } = plan;

  // 3. develop
  switch (plan.developAction.kind) {
    case "create-at-main": {
      const r = await git(repoRoot, io, ["branch", "develop", "main"]);
      if (r.exitCode !== 0) throw new Error(`git branch develop main failed: ${r.stderr.trim()}`);
      setStep(plan, "develop", "done", "created develop at main");
      break;
    }
    case "branch-f": {
      const r = await git(repoRoot, io, ["branch", "-f", "develop", "main"]);
      if (r.exitCode !== 0) throw new Error(`git branch -f develop main failed: ${r.stderr.trim()}`);
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
        throw new Error(
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
        throw new Error(`git symbolic-ref HEAD refs/heads/develop failed: ${r.stderr.trim()}`);
      }
      setStep(plan, "develop", "done", "pointed unborn HEAD at develop");
      break;
    }
    case "already-equal":
      setStep(plan, "develop", "skipped", "develop already equals main");
      break;
  }

  // 4. hooksPath — shared config only.
  if (plan.hooksPathAction === "set") {
    const r = await git(repoRoot, io, ["config", "core.hooksPath", "hooks"]);
    if (r.exitCode !== 0) {
      throw new Error(`git config core.hooksPath hooks failed: ${r.stderr.trim()}`);
    }
    setStep(plan, "hooksPath", "done", "core.hooksPath set to 'hooks'");
  } else {
    setStep(plan, "hooksPath", "skipped", "core.hooksPath already 'hooks'");
  }

  // 5. checkout
  if (plan.checkoutAction === "switch") {
    const r = await git(primary, io, ["switch", "develop"]);
    if (r.exitCode !== 0) {
      throw new Error(`git -C ${primary} switch develop failed: ${r.stderr.trim()}`);
    }
    setStep(plan, "checkout", "done", "primary switched to develop");
  } else {
    setStep(plan, "checkout", "skipped");
  }

  // 6. guard — byte copy of the shipped asset, mode 0755.
  let hookFilesChanged = false;
  const guardPath = join(primary, GUARD_FILE);
  if (plan.guardChange === "write") {
    await io.mkdir(join(primary, "hooks"));
    await io.writeFile(guardPath, readGuardAsset());
    const chmod = await io.exec("chmod", ["0755", guardPath]);
    if (chmod.exitCode !== 0) {
      throw new Error(`chmod 0755 ${GUARD_FILE} failed: ${chmod.stderr.trim()}`);
    }
    hookFilesChanged = true;
    setStep(plan, "guard", "done", "wrote hooks/flow-guard.sh (0755)");
  } else {
    setStep(plan, "guard", "skipped", "hooks/flow-guard.sh already matches the asset");
  }

  // 7. pre-commit — create, insert after the shebang, or replace the block.
  const preCommitPath = join(primary, PRECOMMIT_FILE);
  if (plan.preCommitChange === "identical") {
    setStep(plan, "pre-commit", "skipped", "managed block already present");
  } else {
    const existing = (await io.exists(preCommitPath)) ? await io.readFile(preCommitPath) : null;
    const next =
      existing === null ? renderManagedPreCommit() : mergeManagedBlock(existing);
    if (next === null) {
      setStep(plan, "pre-commit", "skipped", "managed block already present");
    } else {
      await io.mkdir(join(primary, "hooks"));
      await io.writeFile(preCommitPath, next.endsWith("\n") ? next : `${next}\n`);
      const chmod = await io.exec("chmod", ["0755", preCommitPath]);
      if (chmod.exitCode !== 0) {
        throw new Error(`chmod 0755 ${PRECOMMIT_FILE} failed: ${chmod.stderr.trim()}`);
      }
      hookFilesChanged = true;
      setStep(plan, "pre-commit", "done", `${plan.preCommitChange}d managed block in hooks/pre-commit`);
    }
  }

  // 8. adoption commit — under FORGE_FLOW_OP=install, nothing else staged.
  // A failed commit reports status "failed" + stderr + exit 1 (DNA-106).
  if (hookFilesChanged) {
    const add = await git(primary, io, ["add", GUARD_FILE, PRECOMMIT_FILE]);
    if (add.exitCode !== 0) {
      setStep(plan, "commit", "failed", `git add failed: ${add.stderr.trim()}`);
      setStep(plan, "report", "skipped");
      return { check: null, checkDiagnostics: [] };
    }
    const commit = await git(primary, io, ["commit", "-m", ADOPTION_COMMIT_SUBJECT], {
      env: { FORGE_FLOW_OP: "install" },
    });
    if (commit.exitCode !== 0) {
      setStep(plan, "commit", "failed", `git commit failed: ${commit.stderr.trim()}`);
      setStep(plan, "report", "skipped");
      return { check: null, checkDiagnostics: [] };
    }
    setStep(plan, "commit", "done", `committed '${ADOPTION_COMMIT_SUBJECT}' on develop`);
  } else {
    setStep(plan, "commit", "skipped", "hook files unchanged — nothing to commit");
  }

  // 9. report — the flow.check rule set, embedded.
  const outcome = await collectFlowCheck(repoRoot, io);
  setStep(plan, "report", "done", `${outcome.diagnostics.length} diagnostic(s) embedded`);
  return { check: outcome.data, checkDiagnostics: outcome.diagnostics };
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
  const refused = plan.steps.find((s) => s.status === "failed");

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
    exitCode: refused ? 1 : 0,
    summary: refused
      ? `[flow.install] failed at ${refused.step}: ${refused.detail}`
      : `[flow.install] adopted — ${plan.steps.filter((s) => s.status === "done").length} step(s) done, ${checkDiagnostics.length} check diagnostic(s)`,
  };
}
