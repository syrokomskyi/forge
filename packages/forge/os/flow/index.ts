/*
<MODULE_CONTRACT>
<purpose>Public release-line version reader (RFC-1493): the exported
`resolveRepositoryLineVersion(repoRoot, io)` consumers outside Forge call so
they never re-read the tag grammar. For the repository line it returns the
derived `X.Y.Z+N.&lt;head9&gt;[.dirty]` when an annotated release tag is
reachable, else the version-file value.</purpose>
<non-goals>
  <item>No package-line reporting — flow.version owns the full report.</item>
  <item>No diagnostics surface — this is a library function; failure states throw.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>One implementation — deriveLineVersion in line-version.ts is the same derivation flow.version prints (RFC-1465 canonical-reader rule).</item>
  <item>Untagged is not an error — it resolves to the version-file value; only a missing or unparsable version file throws.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1495: step 1 - forge state roots</item>
  <item>RFC-1495: steps 2-3 - workshop paths resolver and call-site migration</item>
  <item>RFC-1519: add advisory gate-verdict store for scoped pass reuse across reruns and the commit-integrate boundary</item>
  <item>RFC-1549: route generated onboarding-status commits through session flow on fixed branches

commitWerkstattSideEffects skips git add+commit when classifyBranch() yields non-flow (protected/nonconforming), reports written outputPaths; status-hook and deploy/leitstand results propagate onboardingStatus metadata; leitstand.promote surfaces an optional session-worktree integration nextStep. Flow-branch commit behavior unchanged; mission-open fixture rebased to conforming auto/task-YYMMDD-NN branch. AC-1..AC-3 checked.</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
  <history>RFC-1493, RFC-1494</history>
</CHANGE_SUMMARY>
*/

import type { WorkspaceIO } from "../../src/types.ts";
import { branchExists, git, worktreeList } from "./git.ts";
import { hasManagedBlock, PRECOMMIT_FILE } from "./guard-files.ts";
import { deriveLineVersion } from "./line-version.ts";
import { detectRepoKind } from "./repo-kind.ts";
import { discoverReleaseLines } from "./release-lines.ts";
import { primaryWorktree, resolveStateRoots, type StateRoots } from "./worktree-path.ts";

// RFC-1495: state-root resolution — Forge owns the roots (mission.archive,
// werkstatt.lock.recover build state paths and Forge must not import
// @warpgogol/*). The engine's workshop-paths builds the names on top.
export { primaryWorktree, resolveStateRoots, worktreeList };
export { FORGE_STATE_FILES } from "./git.ts";
export type { StateRoots };
export type { FlowWorktree } from "./git.ts";
export { classifyBranch } from "./branch-name.ts";
export type { BranchClass } from "./branch-name.ts";
// RFC-1568: gate-run hosts share the common-git-dir resolution.
export { commonGitDir } from "./registry.ts";

export interface RepositoryLineVersion {
  /** "6.451.0+12.ab12cd34e" for a tagged line, "6.451.0" from the version file otherwise. */
  version: string;
  source: "release-tag" | "version-file";
  lastTag: string | null;
}

/**
 * Resolve the repository release line's version: the derived
 * `X.Y.Z+N.<head9>[.dirty]` anchored to the last reachable annotated `v*`
 * tag, or the root package.json `version` when the line was never tagged.
 * Throws only when the version cannot be resolved at all (missing or
 * unparsable version file on an untagged line, or HEAD unresolvable on a
 * tagged one).
 */
export async function resolveRepositoryLineVersion(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<RepositoryLineVersion> {
  const { lines, diagnostics } = await discoverReleaseLines(repoRoot, io);
  const discoveryError = diagnostics.find((d) => d.severity === "error");
  if (discoveryError) {
    throw new Error(`resolveRepositoryLineVersion: ${discoveryError.message}`);
  }
  const repoLine = lines.find((line) => line.id === "repo");
  if (!repoLine) {
    throw new Error("resolveRepositoryLineVersion: no 'repo' release line discovered");
  }
  const derived = await deriveLineVersion(repoRoot, repoLine, io);
  if (derived.version === null) {
    throw new Error(
      derived.source === "version-file"
        ? "resolveRepositoryLineVersion: root package.json is missing or unparsable"
        : "resolveRepositoryLineVersion: release tag present but HEAD is unresolvable",
    );
  }
  return {
    version: derived.version,
    source: derived.source,
    lastTag: derived.lastTag?.name ?? null,
  };
}

/**
 * Adopted into the fixed branch model (FLOW-CUT-01 / FLOW-FIX-01):
 * governed + develop exists + the pre-commit managed block COMMITTED on
 * develop — the committed state is the signal (worktrees check out committed
 * content; a working-tree-only block would not reach a release worktree).
 * RFC-1494: the same test backs leitstand's platform precondition.
 */
export async function isFlowAdopted(repoRoot: string, io: WorkspaceIO): Promise<boolean> {
  const detection = await detectRepoKind(repoRoot, io);
  if (!detection.ok || detection.repoKind.kind !== "governed") return false;
  if (!(await branchExists(repoRoot, io, "develop"))) return false;
  const committed = await git(repoRoot, io, ["show", `develop:${PRECOMMIT_FILE}`]);
  if (committed.exitCode !== 0) return false;
  return hasManagedBlock(committed.stdout);
}
