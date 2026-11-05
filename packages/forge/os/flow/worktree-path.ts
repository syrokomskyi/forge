/*
<MODULE_CONTRACT>
<purpose>Worktree path contracts for the session lifecycle (RFC-1487): the
primary checkout is always the first entry of `git worktree list --porcelain`,
and a flow branch's worktree sits beside the primary as
&lt;parent&gt;/&lt;repo&gt;@&lt;branch-slug&gt; — the sibling depth keeps
sibling-relative paths (../systems-cache, link:../…) resolving unchanged.</purpose>
<non-goals>
  <item>No worktree creation — flow.open decides names and calls git.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>`@` in the directory name is a fixed operator decision (resolutions #1, FI-1) — it cannot collide with a real checkout because no governed branch slug contains it.</item>
  <item>The path derives from the branch name only — renames of the primary directory stay invisible to the registry entry.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 1 — worktree path contracts</item>
  <item>RFC-1487: step 1 — worktree path contracts, O_EXCL locks, branch registry and journal</item>
  <item>RFC-1487: close rfc-1487 review findings — dirty-check parity with git worktree remove, ownership-verified lock release, FLOW-07 registry-error mapping, residual RFC-1462 docs removed

The dirty gate for session worktrees now uses full porcelain status
(untracked files included) because it predicts 'git worktree remove';
the primary-clean gate keeps tracked-only semantics because it predicts
'merge --ff-only'. Lock release verifies the held payload before
unlinking. Registry/journal failures map to FLOW-07 in every handler.
The final branch-name collision reports FLOW-OPEN-04, flow.discard
propagates its teardown result and predicts FLOW-DIS-03 on --dry-run,
and integrate exposes teardown as its own field.</item>
  <item>RFC-1495: step 1 - forge state roots</item>
  <item>RFC-1495: steps 2-3 - workshop paths resolver and call-site migration</item>
</CHANGE_SUMMARY>
*/

import { basename, dirname, join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";
import { canonicalRepoDir } from "../../src/utils/repo-path.ts";

import { topLevel, worktreeList } from "./git.ts";

/**
 * Absolute path of the repository's primary worktree — the first entry of
 * `git worktree list --porcelain`, callable from any linked worktree. Throws
 * when the output lists no worktree; when every entry is bare it falls back
 * to the first entry.
 */
export async function primaryWorktree(
  io: WorkspaceIO,
  anyWorktree: string,
): Promise<string> {
  const worktrees = await worktreeList(anyWorktree, io);
  const primary = worktrees.find((w) => !w.bare) ?? worktrees[0];
  if (!primary) {
    throw new Error("git worktree list returned no worktree — bare repository?");
  }
  return primary.path;
}

/**
 * `<parent>/<repo>@<branch-slug>` — e.g.
 * `/home/u/projects/warpgogol/werkstatt` + `auto/session-261101-01-forge-flow`
 * → `/home/u/projects/warpgogol/werkstatt@auto-session-261101-01-forge-flow`.
 */
export function flowWorktreePath(primary: string, branch: string): string {
  return join(dirname(primary), `${basename(primary)}@${branch.replaceAll("/", "-")}`);
}

/**
 * RFC-1495: the two state roots — the current worktree (per-session code and
 * open missions) and the primary checkout (durable state). In a single
 * worktree both are the same directory, so unadopted repositories resolve
 * every path exactly as before. Non-git directories degrade to the passed
 * root rather than throwing.
 */
export interface StateRoots {
  /** `git rev-parse --show-toplevel` — the worktree this call runs in. */
  worktreeRoot: string;
  /** The first non-bare entry of `git worktree list` — the primary checkout. */
  primaryRoot: string;
  /** worktreeRoot === primaryRoot. */
  isPrimary: boolean;
}

export async function resolveStateRoots(
  repoRoot: string,
  io: WorkspaceIO,
): Promise<StateRoots> {
  const top = await topLevel(repoRoot, io);
  // Both frames canonicalized — git's toplevel and worktreeList paths are
  // native real paths, while the caller's repoRoot may be an 8.3 alias or
  // symlinked spelling of the same directory. Comparing raw strings would
  // silently degrade every Windows call to single-root.
  const canonicalRoot = canonicalRepoDir(repoRoot.replace(/[/\\]+$/, ""));
  // The workshop anchor is the caller's root — only when that root IS the
  // repository worktree root does worktree topology apply. A subdirectory
  // of a repo (or a non-git dir) has no workshop layout to resolve.
  if (!top || top !== canonicalRoot) {
    return { worktreeRoot: repoRoot, primaryRoot: repoRoot, isPrimary: true };
  }
  let primaryRoot: string;
  try {
    primaryRoot = await primaryWorktree(io, repoRoot);
  } catch {
    // worktree list empty or unparseable (non-git io, bare fixtures) —
    // degrade to single-root rather than throwing.
    return { worktreeRoot: repoRoot, primaryRoot: repoRoot, isPrimary: true };
  }
  return {
    worktreeRoot: top,
    primaryRoot,
    isPrimary: top === primaryRoot,
  };
}
