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
  // archive-regen ordering contract: the ecosystem manifest hashes the other
  // generated artifacts, so its generator always runs last.
  return owners.sort(
    (a, b) =>
      Number(a.command === "ecosystem.manifest.generate") -
      Number(b.command === "ecosystem.manifest.generate"),
  );
}

/** Porcelain line → path→status map (rename targets resolved to the new path). */
async function porcelainSnapshot(
  branchWorktree: string,
  io: WorkspaceIO,
): Promise<Map<string, string>> {
  const status = await git(branchWorktree, io, ["status", "--porcelain", "--untracked-files=all"]);
  const map = new Map<string, string>();
  for (const l of status.stdout.split("\n")) {
    if (l.length <= 3) continue;
    const p = l.slice(3);
    const arrow = p.indexOf(" -> ");
    map.set(arrow >= 0 ? p.slice(arrow + 4) : p, l.slice(0, 2));
  }
  return map;
}

function failed(r: { ok?: boolean; exitCode?: number }): boolean {
  return r.ok === false || (r.exitCode !== undefined && r.exitCode !== 0);
}

export async function regenerateAfterRebase(input: {
  branchWorktree: string;
  io: WorkspaceIO;
  invoke: ForgeInvokeCommand;
  owners: ReadonlyArray<{ path: string; command: string }>;
  onProgress?: (line: string) => void;
  /** Owner commands the invoker cannot run here — skipped with a progress line. */
  notRunnable?: ReadonlySet<string>;
}): Promise<PostRebaseRegenResult | PostRebaseRegenRefusal> {
  const { branchWorktree, io, invoke } = input;
  const ran: string[] = [];
  const owners = input.owners.filter((o) => {
    if (!input.notRunnable?.has(o.command)) return true;
    input.onProgress?.(`post-rebase regeneration: ${o.command} not runnable here — skipped`);
    return false;
  });
  if (owners.length === 0) return { ran, committed: [] };

  // Only paths the owner run changes are judged — pre-existing tolerated
  // state (untracked forge files) is not the generators' doing.
  const before = await porcelainSnapshot(branchWorktree, io);
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

  const after = await porcelainSnapshot(branchWorktree, io);
  const changed = [...after.entries()].filter(([p, st]) => before.get(p) !== st).map(([p]) => p);
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

  // A generator bug must never be masked: validate the regenerated tree
  // before anything is staged, so a red result leaves no commit behind.
  if (ran.includes("ecosystem.manifest.generate")) {
    const validate = await invoke("ecosystem.manifest.validate", {});
    if (failed(validate)) {
      return {
        refused: true,
        message: `post-rebase regeneration: ecosystem.manifest.validate still red — ${validate.summary ?? `exit ${validate.exitCode}`}`,
        fixHint:
          "the regenerated manifest is itself invalid — fix the generator input, regenerate, commit, re-run flow.integrate",
      };
    }
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
  input.onProgress?.(
    `post-rebase regeneration: committed ${committed.join(", ")} (${sha.slice(0, 9)})`,
  );
  return { ran, committed, sha };
}
