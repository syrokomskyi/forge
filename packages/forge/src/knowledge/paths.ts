/*
<MODULE_CONTRACT>
<purpose>Owning-checkout resolution for skill-knowledge writers (RFC-1599):
resolveKnowledgeRoot walks up from the writer's cwd to the nearest `.git`
— a directory marks the primary checkout, a gitfile marks a linked session
worktree — so `.agents/` state binds to the checkout the writing session
owns, never to a fixed project root shared by parallel sessions. When no
checkout resolves, the writer falls back to `&lt;start&gt;/.agents-local/`
(gitignored) instead of writing across the boundary.</purpose>
<non-goals>
  <item>No knowledge-file schema — writers keep their own formats; this resolves the target root only.</item>
  <item>No migration — knowledge already in a primary stays; new writes bind forward.</item>
</non-goals>
<KEY_DECISIONS>
  <item>The nearest `.git` wins — nested worktrees and submodule checkouts bind to their own checkout, matching git's own worktree resolution.</item>
  <item>`.git` as a FILE (gitfile) classifies "worktree"; `.git` as a DIRECTORY classifies "primary" — no common-dir parsing needed.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1599: owning-checkout knowledge-path resolver + .agents-local fallback</item>
  <item>RFC-1599: sweep primary dirt into opened worktrees + bind session writes to the owning checkout (RFC-1599)</item>
</CHANGE_SUMMARY>
*/

import { dirname, join } from "node:path";

import type { WorkspaceIO } from "../types.ts";
import { resolveIo } from "../utils/io.ts";

export type KnowledgeRootKind = "worktree" | "primary" | "fallback";

export interface KnowledgeRootResolution {
  /**
   * Root of the writable knowledge tree — `<checkout>/.agents` for bound
   * resolutions, `<start>/.agents-local` when no checkout owns the cwd.
   */
  agentsRoot: string;
  /** The owning checkout root; null on the fallback path. */
  checkoutRoot: string | null;
  kind: KnowledgeRootKind;
}

/**
 * Walk up from `startDir` to the nearest `.git`. A `.git` FILE is a linked
 * worktree's gitfile (kind "worktree"); a `.git` DIRECTORY is the primary
 * checkout's real git dir (kind "primary"). Nothing found → fallback —
 * `agentsRoot` points at `<startDir>/.agents-local`, which `.gitignore`
 * covers, so writes never leak into a shared checkout or vanish silently.
 */
export async function resolveKnowledgeRoot(
  startDir: string,
  io?: WorkspaceIO,
): Promise<KnowledgeRootResolution> {
  const resolved = resolveIo(io);
  let dir = startDir;
  for (;;) {
    const marker = join(dir, ".git");
    if (await resolved.exists(marker)) {
      const stat = await resolved.stat(marker).catch(() => null);
      const kind: KnowledgeRootKind = stat?.isDirectory ? "primary" : "worktree";
      return {
        agentsRoot: join(dir, ".agents"),
        checkoutRoot: dir,
        kind,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    agentsRoot: join(startDir, ".agents-local"),
    checkoutRoot: null,
    kind: "fallback",
  };
}
