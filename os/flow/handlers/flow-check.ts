/*
<MODULE_CONTRACT>
<purpose>flow.check — the read-only fixed-branch-model validator (RFC-1486).
Reports FLOW-01..05 over the repository containing the workspace root:
branch-name conformance, develop existence, guard installation (byte-exact),
the owed back-merge, and marker schema validity. collectFlowCheck is reused
by flow.install step 9.</purpose>
<non-goals>
  <item>No mutation — FLOW-01 names stray branches, nothing is deleted.</item>
  <item>No activation — wired into pipelines by the wave-4 switch-over RFC.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>An invalid forge.generated.yaml fails closed: the repo is checked as governed AND carries FLOW-05 — a malformed marker must never unprotect (repo-kind.ts KEY_DECISIONS).</item>
  <item>Ungoverned repositories (no forge.yaml, no marker) report repoKind with no diagnostics — the model only applies where forge.yaml opts in.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1488: review r1 — parse guard, door/rules metadata, id-exact RFC binding, refname precision, FLOW-09 top-level anchor, test cleanup</item>
  <item>RFC-1487: step 5 — flow.discard, flow.status, flow.check FLOW-06/07</item>
  <item>RFC-1490: pre-merge-commit guard mode + per-mode op vocabulary; amends the wave-1 guard RFC's backmerge escape (AC-11)</item>
  <item>RFC-1491: step 2 — pre-push guard mode, install steps pre-push + markers, FLOW-10</item>
  <item>RFC-1498: step 1 — FLOW-07 for stray auto branches

collectFlowStatus exposes unregisteredBranchesWithoutWorktree — local auto/* branch names with no registry entry and no worktree checkout anywhere (primary or linked), the shape a failed branch -D leaves behind. flow.check emits one FLOW-07 warning per stray regardless of age: the 72 h rule in FLOW-06 only covered staleness, so a fresh leftover went unreported. The fix hint names flow.status for inspection and flow.discard for teardown, and flags that a branch with unique commits needs a human decision. Tests AC-1 (fresh stray branch reports FLOW-07, not FLOW-06) and AC-2 (a registered session with a live worktree reports none).</item>
  <history>RFC-1486, RFC-1488</history>
</CHANGE_SUMMARY>
*/

import type {
  CheckResult,
  Diagnostic,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  WorkspaceIO,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { classifyBranch } from "../branch-name.ts";
import {
  branchExists,
  configGet,
  isBare,
  listLocalBranches,
  requireGit,
  revListCount,
  topLevel,
} from "../git.ts";
import {
  guardFileMatches,
  GUARD_FILE,
  hasManagedBlock,
  PRECOMMIT_FILE,
  PREMERGE_FILE,
  PREPUSH_FILE,
} from "../guard-files.ts";
import { MARKER_FILE, markerContentIsValid } from "../markers.ts";
import { detectRepoKind, readRepoRootFile } from "../repo-kind.ts";
import { collectFlowStatus } from "./flow-status.ts";
import {
  discoverReleaseLines,
  readLineVersionFile,
  type ReleaseLine,
} from "../release-lines.ts";
import { listLineTags } from "../release-tags.ts";
import { compareVersions, parseVersion } from "../semver.ts";
import { STALE_AFTER_HOURS } from "../registry.ts";

export interface FlowCheckBranches {
  protected: string[];
  flow: string[];
  nonconforming: string[];
}

export interface FlowCheckData {
  repoKind: "governed" | "exempt" | "ungoverned";
  exempt: boolean;
  marker?: { schema: string; generator: string; source: string };
  branches: FlowCheckBranches;
  guardInstalled: boolean;
  /** Commits in main not in develop; null when either side is absent. */
  mainAheadOfDevelop: number | null;
  /** Discovered release-line ids (RFC-1488); absent on exempt/ungoverned verdicts. */
  releaseLines?: string[];
}

export interface FlowCheckOutcome {
  data: FlowCheckData;
  diagnostics: Diagnostic[];
}

const EMPTY_BRANCHES: FlowCheckBranches = { protected: [], flow: [], nonconforming: [] };

/**
 * Evaluate FLOW-01..05 over `repoRoot` (a git top level). Purely read-only;
 * flow.install embeds the outcome as its step-9 report.
 */
export async function collectFlowCheck(
  repoRoot: string,
  io: WorkspaceIO,
  opts?: { now?: Date },
): Promise<FlowCheckOutcome> {
  const diagnostics: Diagnostic[] = [];
  const detection = await detectRepoKind(repoRoot, io);
  const bare = await isBare(repoRoot, io);

  if (!detection.ok) {
    diagnostics.push({
      ruleId: "FLOW-05",
      severity: "error",
      file: "forge.generated.yaml",
      message: detection.detail,
      fixHint: "fix forge.generated.yaml to satisfy the forge/generated@1 schema or remove it",
    });
  }

  if (detection.ok && detection.repoKind.kind === "exempt") {
    return {
      data: {
        repoKind: "exempt",
        exempt: true,
        marker: detection.repoKind.marker,
        branches: EMPTY_BRANCHES,
        guardInstalled: false,
        mainAheadOfDevelop: null,
      },
      diagnostics,
    };
  }

  if (detection.ok && detection.repoKind.kind === "ungoverned") {
    return {
      data: {
        repoKind: "ungoverned",
        exempt: false,
        branches: EMPTY_BRANCHES,
        guardInstalled: false,
        mainAheadOfDevelop: null,
      },
      diagnostics,
    };
  }

  // Governed (or fail-closed governed after an invalid marker).
  const branches: FlowCheckBranches = { protected: [], flow: [], nonconforming: [] };
  for (const name of await listLocalBranches(repoRoot, io)) {
    const cls = classifyBranch(name);
    if (cls.kind === "protected") branches.protected.push(name);
    else if (cls.kind === "flow") branches.flow.push(name);
    else branches.nonconforming.push(name);
  }
  branches.protected.sort();
  branches.flow.sort();
  branches.nonconforming.sort();

  for (const name of branches.nonconforming) {
    diagnostics.push({
      ruleId: "FLOW-01",
      severity: "error",
      message: `branch '${name}' is outside the fixed branch model`,
      fixHint: `integrate or delete it; fully merged: git branch -d ${name}`,
    });
  }

  const developExists = await branchExists(repoRoot, io, "develop");
  const mainExists = await branchExists(repoRoot, io, "main");
  if (!developExists) {
    diagnostics.push({
      ruleId: "FLOW-02",
      severity: "error",
      message: "branch 'develop' does not exist",
      fixHint: "run pnpm exec forge flow.install to adopt the fixed branch model",
    });
  }

  const guardReasons: string[] = [];
  const hooksPath = await configGet(repoRoot, io, "core.hooksPath");
  if (hooksPath !== "hooks") {
    guardReasons.push(
      hooksPath === null
        ? "core.hooksPath is not set to 'hooks'"
        : `core.hooksPath is '${hooksPath}', expected 'hooks'`,
    );
  }
  const preCommit = await readRepoRootFile(repoRoot, PRECOMMIT_FILE, io, bare);
  if (preCommit === null || !hasManagedBlock(preCommit)) {
    guardReasons.push(
      preCommit === null
        ? "hooks/pre-commit is missing"
        : "hooks/pre-commit does not carry the managed flow-guard block",
    );
  }
  const preMerge = await readRepoRootFile(repoRoot, PREMERGE_FILE, io, bare);
  if (preMerge === null || !hasManagedBlock(preMerge, "pre-merge-commit")) {
    guardReasons.push(
      preMerge === null
        ? "hooks/pre-merge-commit is missing"
        : "hooks/pre-merge-commit does not carry the managed flow-guard block",
    );
  }
  const prePush = await readRepoRootFile(repoRoot, PREPUSH_FILE, io, bare);
  if (prePush === null || !hasManagedBlock(prePush, "pre-push")) {
    guardReasons.push(
      prePush === null
        ? "hooks/pre-push is missing"
        : "hooks/pre-push does not carry the managed flow-guard block",
    );
  }
  if (!(await guardFileMatches(() => readRepoRootFile(repoRoot, GUARD_FILE, io, bare)))) {
    guardReasons.push("hooks/flow-guard.sh is missing or differs from the shipped asset");
  }
  diagnostics.push(
    ...guardReasons.map((reason) => ({
      ruleId: "FLOW-03",
      severity: "error" as const,
      message: `guard not installed: ${reason}`,
      fixHint: "run pnpm exec forge flow.install to (re)install the guard",
    })),
  );

  let mainAheadOfDevelop: number | null = null;
  if (mainExists && developExists) {
    mainAheadOfDevelop = await revListCount(repoRoot, io, "develop..main");
    if (mainAheadOfDevelop > 0) {
      diagnostics.push({
        ruleId: "FLOW-04",
        severity: "warning",
        message: `main has ${mainAheadOfDevelop} commit(s) that are not in develop (a back-merge is owed)`,
        fixHint: "back-merge main into develop via the release flow",
      });
    }
  }

  // FLOW-06/07 (RFC-1487) — session-branch hygiene over the shared status
  // view: stale auto branches warn, and registry/git/worktree disagreements
  // warn (a schema-invalid registry escalates to error). Skipped on bare
  // repositories — a bare repo has no worktrees to inspect.
  const status = bare
    ? null
    : await collectFlowStatus(repoRoot, io, { now: opts?.now });
  for (const b of status?.data.branches ?? []) {
    if (b.stale) {
      diagnostics.push({
        ruleId: "FLOW-06",
        severity: "warning",
        message:
          `auto branch '${b.name}' is stale (no activity for ${STALE_AFTER_HOURS} h` +
          `${b.registered ? ", registered" : ", unregistered"})`,
        fixHint: `integrate it with flow.integrate or drop it with flow.discard --reason "<why>"`,
      });
    }
  }
  if (status?.registryError) {
    diagnostics.push({
      ruleId: "FLOW-07",
      severity: "error",
      file: status.registryError.file,
      message: status.registryError.message,
      fixHint: `repair or remove ${status.registryError.file} — every flow command reads it`,
    });
  }
  for (const e of status?.missingBranchEntries ?? []) {
    diagnostics.push({
      ruleId: "FLOW-07",
      severity: "warning",
      message: `registry entry '${e.name}' names a branch ref that does not exist`,
      fixHint: "re-run flow.integrate/flow.discard to finish the cleanup, or repair the registry entry",
    });
  }
  for (const e of status?.missingWorktreeEntries ?? []) {
    diagnostics.push({
      ruleId: "FLOW-07",
      severity: "warning",
      message: `registry entry '${e.name}' names worktree ${e.worktree}, which does not exist`,
      fixHint: "re-run flow.integrate/flow.discard to finish the cleanup, or repair the registry entry",
    });
  }
  for (const path of status?.unregisteredWorktrees ?? []) {
    diagnostics.push({
      ruleId: "FLOW-07",
      severity: "warning",
      message: `worktree ${path} carries an auto branch with no registry entry`,
      fixHint: "open sessions through flow.open — a manual worktree bypasses the lifecycle",
    });
  }
  // RFC-1498: a stray auto branch — no registry entry, no worktree — is
  // reported the moment it exists; the 72 h staleness rule never delayed it.
  for (const name of status?.unregisteredBranchesWithoutWorktree ?? []) {
    diagnostics.push({
      ruleId: "FLOW-07",
      severity: "warning",
      message: `branch '${name}' has no registry entry and no worktree`,
      fixHint:
        "inspect with flow.status; integrate it through a registered session or drop it " +
        "with flow.discard --reason \"<why>\" — a branch with unique commits needs a human decision",
    });
  }

  // FLOW-08/09 (RFC-1488) — release-line hygiene. A version file diverging
  // from its line's last tag is an error (the file is only written at a
  // release cut); an extract.config.yaml declaring versionBump is a warning
  // because repo-extract would rewrite the version during export.
  const { lines, diagnostics: discoveryDiagnostics } = await discoverReleaseLines(repoRoot, io);
  diagnostics.push(...discoveryDiagnostics);
  for (const line of lines) {
    await collectLineDiagnostics(repoRoot, line, io, bare, diagnostics);
  }

  return {
    data: {
      repoKind: "governed",
      exempt: false,
      branches,
      guardInstalled: guardReasons.length === 0,
      mainAheadOfDevelop,
      releaseLines: lines.map((l) => l.id),
    },
    diagnostics,
  };
}

/**
 * FLOW-08 (error): the line's version file carries a `version` that differs
 * from its last reachable annotated tag — including the never-baselined case
 * (no tag at all). A version file without `version` does not fire. FLOW-09
 * (warning): the line's extract.config.yaml declares `versionBump`.
 */
async function collectLineDiagnostics(
  repoRoot: string,
  line: ReleaseLine,
  io: WorkspaceIO,
  bare: boolean,
  diagnostics: Diagnostic[],
): Promise<void> {
  const versionText = await readLineVersionFile(repoRoot, line, io);
  const { lastTag } = await listLineTags(repoRoot, line, io);
  if (versionText !== null) {
    const fileVersion = parseVersion(versionText);
    const tagVersion = lastTag?.version ?? null;
    const differs =
      tagVersion === null
        ? true // version present but the line was never baselined
        : fileVersion === null || compareVersions(fileVersion, tagVersion) !== 0;
    if (differs) {
      const fileHigher =
        fileVersion !== null && (tagVersion === null || compareVersions(fileVersion, tagVersion) > 0);
      diagnostics.push({
        ruleId: "FLOW-08",
        severity: "error",
        file: line.versionFile ?? undefined,
        message:
          `release line '${line.id}': version file says ${versionText} but its last tag is ` +
          `${lastTag?.name ?? "(none — never baselined)"}`,
        fixHint: fileHigher
          ? "run pnpm exec forge flow.install to create the baseline tag"
          : "a version file is only written at a release cut — restore it or cut a release",
      });
    }
  }
  if (line.id !== "repo") {
    // FLOW-10 (error, RFC-1491): the line dir must carry a valid marker so
    // repo-extract exports it into the extract repository.
    const markerPath = `${line.paths[0]}/${MARKER_FILE}`;
    const markerRaw = await readRepoRootFile(repoRoot, markerPath, io, bare);
    if (!markerContentIsValid(markerRaw)) {
      diagnostics.push({
        ruleId: "FLOW-10",
        severity: "error",
        file: markerPath,
        message: `package line '${line.id}' has no valid forge.generated.yaml in ${line.paths[0]}`,
        fixHint: "run pnpm exec forge flow.install — the markers step writes it into the adoption commit",
      });
    }
    const extractPath = `${line.paths[0]}/extract.config.yaml`;
    const raw = await readRepoRootFile(repoRoot, extractPath, io, bare);
    // Top-level key only — an indented `versionBump:` under a nested section
    // is not the repo-extract declaration this rule guards.
    if (raw !== null && /^versionBump\s*:/m.test(raw)) {
      diagnostics.push({
        ruleId: "FLOW-09",
        severity: "warning",
        file: extractPath,
        message: `release line '${line.id}' declares versionBump in ${extractPath} — repo-extract would rewrite the version during export`,
        fixHint: "remove versionBump from extract.config.yaml — versions are cut by the release flow",
      });
    }
  }
}

export interface FlowCheckResult extends CheckResult {
  repoKind: FlowCheckData["repoKind"];
  exempt: boolean;
  branches: FlowCheckBranches;
  guardInstalled: boolean;
  mainAheadOfDevelop: number | null;
  releaseLines?: string[];
}

export async function runFlowCheck(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<FlowCheckResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.check must run inside a git repository");
  }

  const { data, diagnostics } = await collectFlowCheck(repoRoot, io);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  const status = errors.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass";

  if (outputFormat === "pretty") {
    logger.section("Flow check");
    logger.info(`  repoKind: ${data.repoKind}`);
    if (data.repoKind === "governed") {
      logger.info(
        `  branches: ${data.branches.protected.length} protected, ${data.branches.flow.length} flow, ${data.branches.nonconforming.length} non-conforming`,
      );
      logger.info(`  guardInstalled: ${data.guardInstalled}`);
    }
    for (const d of diagnostics) {
      if (d.severity === "error") logger.error(`  ${d.ruleId}: ${d.message}`);
      else logger.warn(`  ${d.ruleId}: ${d.message}`);
    }
  }

  return {
    data: {
      command: "flow.check",
      status,
      repoKind: data.repoKind,
      exempt: data.exempt,
      branches: data.branches,
      guardInstalled: data.guardInstalled,
      mainAheadOfDevelop: data.mainAheadOfDevelop,
      releaseLines: data.releaseLines,
      diagnostics,
      summary: { error: errors.length, warning: warnings.length, info: 0 },
    },
    exitCode: errors.length > 0 ? 1 : 0,
    summary: `[flow.check] ${data.repoKind} — ${errors.length} error(s), ${warnings.length} warning(s)`,
  };
}
