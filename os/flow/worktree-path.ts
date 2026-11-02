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
</CHANGE_SUMMARY>
*/

import { basename, dirname, join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";

import { worktreeList } from "./git.ts";

/**
 * Absolute path of the repository's primary worktree — the first entry of
 * `git worktree list --porcelain`, callable from any linked worktree. Throws
 * when the output lists no worktree (bare repository).
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
