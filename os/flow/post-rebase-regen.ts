/*
<MODULE_CONTRACT>
<purpose>RFC-1574 — flow.integrate step (3b): after a successful rebase onto
  develop, run every GENERATED_BASENAME_OWNERS owner command in the session
  worktree and commit exactly the owned generated files that changed, with a
  fixed subject, before the integration gate runs. Replaces RFC-1546's
  pre-rebase in-place regeneration, which wrote the file but never committed
  it (the rebase then refused FLOW-INT-02 on the dirty worktree, F-0168).</purpose>
<non-goals>
  <item>No conflict resolution — RFC-1538/1545 own generated rebase conflicts.</item>
  <item>No port entries — flow.backmerge never rebases.</item>
  <item>Never stages a non-owned path; any other dirt refuses.</item>
</non-goals>
</MODULE_CONTRACT>
*/
import { join } from "node:path";

import type { ForgeInvokeCommand, WorkspaceIO } from "../../src/types.ts";
import { REGEN_FLAGS } from "../core/archive-regen.ts";
import { git, gitCommit } from "./git.ts";
import { GENERATED_BASENAME_OWNERS } from "./preflight.ts";

export const POST_REBASE_REGEN_SUBJECT = "chore(flow): regenerate derived manifests after rebase";

/** Generated manifests live under docs/ by convention (RFC-1538 owner map). */
const GENERATED_DIR = "docs";

export interface PostRebaseRegenResult {
  /** owner commands invoked, in GENERATED_BASENAME_OWNERS order */
  ran: string[];
  /** repo-relative generated paths that changed and were committed */
  committed: string[];
  /** sha of the regeneration commit; undefined when nothing changed */
  sha?: string;
}

export interface PostRebaseRegenRefusal {
  refused: true;
  message: string;
  fixHint: string;
}

/** Owner commands for the generated files present in the worktree. */
export async function postRebaseOwners(
  branchWorktree: string,
  io: WorkspaceIO,
): Promise<Array<{ path: string; command: string }>> {
  const owners: Array<{ path: string; command: string }> = [];
  for (const [basename, command] of Object.entries(GENERATED_BASENAME_OWNERS)) {
    const path = `${GENERATED_DIR}/${basename}`;
    if (await io.exists(join(branchWorktree, path))) owners.push({ path, command });
  }
  return owners;
}

function failed(r: { ok?: boolean; exitCode?: number }): boolean {
  return r.ok === false || (r.exitCode !== undefined && r.exitCode !== 0);
}

/** Porcelain v1 paths (rename targets resolved to the new path). */
function porcelainPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(" -> ");
      return arrow >= 0 ? p.slice(arrow + 4) : p;
    });
}

export async function regenerateAfterRebase(input: {
  branchWorktree: string;
  io: WorkspaceIO;
  invoke: ForgeInvokeCommand;
  owners: ReadonlyArray<{ path: string; command: string }>;
  onProgress?: (line: string) => void;
}): Promise<PostRebaseRegenResult | PostRebaseRegenRefusal> {
  const { branchWorktree, io, invoke, owners } = input;
  const ran: string[] = [];
  if (owners.length === 0) return { ran, committed: [] };

  for (const o of owners) {
    const result = await invoke(o.command, REGEN_FLAGS[o.command] ?? {});
    if (failed(result)) {
      return {
        refused: true,
        message: `post-rebase regeneration: ${o.command} failed — ${result.summary ?? `exit ${result.exitCode}`}`,
        fixHint: `run ${o.command} inside the session worktree, inspect and commit the diff, then re-run flow.integrate`,
      };
    }
    ran.push(o.command);
  }

  const status = await git(branchWorktree, io, ["status", "--porcelain", "--untracked-files=all"]);
  const changed = porcelainPaths(status.stdout);
  const owned = new Set(owners.map((o) => o.path));
  const foreign = changed.filter((p) => !owned.has(p));
  if (foreign.length > 0) {
    return {
      refused: true,
      message: `post-rebase regeneration dirtied non-owned path(s): ${foreign.join(", ")}`,
      fixHint:
        "an owner command wrote outside its generated file — inspect the worktree, commit or revert by hand, then re-run flow.integrate",
    };
  }
  const committed = changed.filter((p) => owned.has(p));
  if (committed.length === 0) {
    input.onProgress?.("post-rebase regeneration: no drift");
    return { ran, committed };
  }

  const add = await git(branchWorktree, io, ["add", "--", ...committed]);
  const commit =
    add.exitCode === 0
      ? await gitCommit(
          branchWorktree,
          io,
          ["commit", "-m", POST_REBASE_REGEN_SUBJECT],
          "integrate",
        )
      : add;
  if (commit.exitCode !== 0) {
    return {
      refused: true,
      message: `post-rebase regeneration commit failed: ${commit.stderr.trim().split("\n").slice(-3).join(" | ")}`,
      fixHint:
        "commit the regenerated manifest(s) inside the session worktree, then re-run flow.integrate",
    };
  }
  const sha = (await git(branchWorktree, io, ["rev-parse", "HEAD"])).stdout.trim();

  // A generator bug must never be masked: the regenerated manifest is
  // validated once more when the validator is available.
  const validate = await invoke("ecosystem.manifest.validate", {});
  if (failed(validate)) {
    return {
      refused: true,
      message: `post-rebase regeneration: ecosystem.manifest.validate still red — ${validate.summary ?? `exit ${validate.exitCode}`}`,
      fixHint:
        "the regenerated manifest is itself invalid — fix the generator input, regenerate, commit, re-run flow.integrate",
    };
  }
  input.onProgress?.(
    `post-rebase regeneration: committed ${committed.join(", ")} (${sha.slice(0, 9)})`,
  );
  return { ran, committed, sha };
}
