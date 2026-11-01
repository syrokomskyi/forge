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
  <item>RFC-1486: step 3 — flow.check handler + collectFlowCheck</item>
  <item>RFC-1486: step 3 — flow.check with FLOW-01..05 + managed-block helpers</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

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
} from "../guard-files.ts";
import { detectRepoKind } from "../repo-kind.ts";

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
}

export interface FlowCheckOutcome {
  data: FlowCheckData;
  diagnostics: Diagnostic[];
}

const EMPTY_BRANCHES: FlowCheckBranches = { protected: [], flow: [], nonconforming: [] };

async function readRepoFile(
  repoRoot: string,
  name: string,
  io: WorkspaceIO,
  bare: boolean,
): Promise<string | null> {
  if (bare) {
    const result = await io.exec("git", ["-C", repoRoot, "show", `HEAD:${name}`]);
    return result.exitCode === 0 ? result.stdout : null;
  }
  const path = join(repoRoot, name);
  return (await io.exists(path)) ? io.readFile(path) : null;
}

/**
 * Evaluate FLOW-01..05 over `repoRoot` (a git top level). Purely read-only;
 * flow.install embeds the outcome as its step-9 report.
 */
export async function collectFlowCheck(
  repoRoot: string,
  io: WorkspaceIO,
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
  const preCommit = await readRepoFile(repoRoot, PRECOMMIT_FILE, io, bare);
  if (preCommit === null || !hasManagedBlock(preCommit)) {
    guardReasons.push(
      preCommit === null
        ? "hooks/pre-commit is missing"
        : "hooks/pre-commit does not carry the managed flow-guard block",
    );
  }
  if (!(await guardFileMatches(() => readRepoFile(repoRoot, GUARD_FILE, io, bare)))) {
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

  return {
    data: {
      repoKind: "governed",
      exempt: false,
      branches,
      guardInstalled: guardReasons.length === 0,
      mainAheadOfDevelop,
    },
    diagnostics,
  };
}

export interface FlowCheckResult extends CheckResult {
  repoKind: FlowCheckData["repoKind"];
  exempt: boolean;
  branches: FlowCheckBranches;
  guardInstalled: boolean;
  mainAheadOfDevelop: number | null;
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
      diagnostics,
      summary: { error: errors.length, warning: warnings.length, info: 0 },
    },
    exitCode: errors.length > 0 ? 1 : 0,
    summary: `[flow.check] ${data.repoKind} — ${errors.length} error(s), ${warnings.length} warning(s)`,
  };
}
