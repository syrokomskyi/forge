/*
<MODULE_CONTRACT>
<purpose>RFC-1574 — flow.integrate step (3b): after a successful rebase onto
  develop, run every GENERATED_BASENAME_OWNERS owner command in the session
  worktree and commit exactly the owned generated files that changed, with a
  fixed subject, before the integration gate runs. Replaces RFC-1546's
  pre-rebase in-place regeneration, which wrote the file but never committed
  it (the rebase then refused FLOW-INT-02 on the dirty worktree, F-0168).
  RFC-1619: a successful regen also writes a forge/post-rebase-regen@1
  provenance record under &lt;commonGitDir&gt;/forge/regen-records/ — the
  gate's manifests step binds to it (file == this flow's own regen output)
  instead of re-rendering with a pre-merge engine.</purpose>
<non-goals>
  <item>No conflict resolution — RFC-1538/1545 own generated rebase conflicts.</item>
  <item>No port entries — flow.backmerge never rebases.</item>
  <item>Never stages a non-owned path; any other dirt refuses.</item>
  <item>The record is advisory — a write failure degrades to the gate's
    in-process validator fallback, never a refusal.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1619: forge/post-rebase-regen@1 provenance record — blob-sha output map + advisory write on every successful regen</item>
  <item>RFC-1622: bind RFC-1622 manifest regeneration to rendered bytes</item>
</CHANGE_SUMMARY>
</MODULE_CONTRACT>
*/
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

import type { ForgeFlagValue, ForgeInvokeCommand, WorkspaceIO } from "../../src/types.ts";
import { REGEN_FLAGS } from "../core/archive-regen.ts";
import { git, gitCommit } from "./git.ts";
import { GENERATED_BASENAME_OWNERS } from "./preflight.ts";

export const POST_REBASE_REGEN_SUBJECT = "chore(flow): regenerate derived manifests after rebase";

/** Generated manifests live under docs/ by convention (RFC-1538 owner map). */
const GENERATED_DIR = "docs";

/** RFC-1619: provenance-record schema the integration gate's manifests step binds to. */
export const REGEN_RECORD_SCHEMA = "forge/post-rebase-regen@1";
/** Record directory below `<commonGitDir>/forge/` — sibling of gate-runs and the verdict store. */
export const REGEN_RECORD_DIR = "regen-records";

/** forge/post-rebase-regen@1 — what step (3b) produced, keyed by blob sha. */
export interface PostRebaseRegenRecord {
  schema: typeof REGEN_RECORD_SCHEMA;
  at: string;
  /** develop sha the branch rebased onto — must equal the gate's --base. */
  baseSha: string;
  /** branch HEAD after the regen commit (if any) — must equal the gated tip. */
  branchTip: string;
  /** repo-relative generated path → `git hash-object` of the regen output. */
  outputs: Record<string, string>;
}

/** Record filename for a branch — the same flattening rule gate reports use. */
export function regenRecordFileName(branch: string): string {
  return `${branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"}.json`;
}

/**
 * RFC-1619: persist `<commonGitDir>/forge/regen-records/<branch>.json` naming
 * every owned generated path's post-regen blob sha. Advisory — a write
 * failure only costs the gate its binding fast path, never the verdict.
 */
async function writePostRebaseRegenRecord(
  branchWorktree: string,
  io: WorkspaceIO,
  input: {
    baseSha: string;
    ownedPaths: ReadonlyArray<string>;
    onProgress?: (line: string) => void;
  },
): Promise<void> {
  try {
    const [commonDir, branchRes, tip] = await Promise.all([
      git(branchWorktree, io, ["rev-parse", "--git-common-dir"]),
      git(branchWorktree, io, ["branch", "--show-current"]),
      git(branchWorktree, io, ["rev-parse", "HEAD"]),
    ]);
    if (commonDir.exitCode !== 0 || tip.exitCode !== 0) return;
    const common = commonDir.stdout.trim();
    const gitCommon = isAbsolute(common) ? common : resolve(branchWorktree, common);
    const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : "";
    const outputs: Record<string, string> = {};
    for (const p of input.ownedPaths) {
      if (!(await io.exists(join(branchWorktree, p)))) continue;
      const h = await git(branchWorktree, io, ["hash-object", "--", p]);
      if (h.exitCode === 0) outputs[p] = h.stdout.trim();
    }
    const record: PostRebaseRegenRecord = {
      schema: REGEN_RECORD_SCHEMA,
      at: new Date().toISOString(),
      baseSha: input.baseSha,
      branchTip: tip.stdout.trim(),
      outputs,
    };
    const dir = join(gitCommon, "forge", REGEN_RECORD_DIR);
    await io.mkdir(dir);
    await io.writeFile(
      join(dir, regenRecordFileName(branch)),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    input.onProgress?.("post-rebase regen record written (RFC-1619)");
  } catch (error) {
    input.onProgress?.(
      `post-rebase regen record skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface PostRebaseRegenResult {
  /** owner commands invoked — GENERATED_BASENAME_OWNERS order with ecosystem.manifest.generate last (archive-regen ordering) */
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

/** A regen owner entry — `flags` overrides REGEN_FLAGS for deferred owners (RFC-1602). */
export interface PostRebaseOwner {
  path: string;
  command: string;
  flags?: Record<string, ForgeFlagValue>;
}

/** Owner commands for the generated files present in the worktree. */
export async function postRebaseOwners(
  branchWorktree: string,
  io: WorkspaceIO,
): Promise<PostRebaseOwner[]> {
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
  owners: ReadonlyArray<PostRebaseOwner>;
  /** Extra owned paths beyond owners[].path — deferred owners own a path set (RFC-1602). */
  extraOwnedPaths?: ReadonlyArray<string>;
  /** RFC-1619: develop sha the branch rebased onto — presence enables the
   * provenance-record write the gate's manifests step binds to. */
  baseSha?: string;
  onProgress?: (line: string) => void;
  /** Owner commands the invoker cannot run here — skipped with a progress line. */
  notRunnable?: ReadonlySet<string>;
}): Promise<PostRebaseRegenResult | PostRebaseRegenRefusal> {
  const { branchWorktree, io, invoke } = input;
  const ran: string[] = [];
  let manifestDigest: string | undefined;
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
    const result = await invoke(o.command, o.flags ?? REGEN_FLAGS[o.command] ?? {});
    if (failed(result)) {
      return {
        refused: true,
        message: `post-rebase regeneration: ${o.command} failed — ${result.summary ?? `exit ${result.exitCode}`}`,
        fixHint: `run ${o.command} inside the session worktree, inspect and commit the diff, then re-run flow.integrate`,
      };
    }
    ran.push(o.command);
    if (
      o.command === "ecosystem.manifest.generate" &&
      result.data &&
      typeof result.data === "object"
    ) {
      const data = result.data as { file?: unknown; sha256?: unknown };
      if (
        data.file === "docs/ecosystem.generated.yaml" &&
        typeof data.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(data.sha256)
      ) {
        manifestDigest = data.sha256;
      }
    }
  }

  if (manifestDigest !== undefined) {
    let actual: string;
    try {
      actual = createHash("sha256")
        .update(await io.readFile(join(branchWorktree, "docs/ecosystem.generated.yaml")), "utf8")
        .digest("hex");
    } catch {
      actual = "";
    }
    if (actual !== manifestDigest) {
      return {
        refused: true,
        message: "post-rebase regeneration: ecosystem manifest differs from the generated bytes",
        fixHint: "inspect the manifest generator and worktree, then re-run flow.integrate",
      };
    }
  }

  // A generator bug must never be masked: validate the regenerated tree
  // before anything is staged, so a red result leaves no commit behind.
  if (ran.includes("ecosystem.manifest.generate") && manifestDigest === undefined) {
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

  const after = await porcelainSnapshot(branchWorktree, io);
  const changed = [...after.entries()].filter(([p, st]) => before.get(p) !== st).map(([p]) => p);
  const owned = new Set([...owners.map((o) => o.path), ...(input.extraOwnedPaths ?? [])]);
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
    if (manifestDigest !== undefined) {
      const blob = await git(branchWorktree, io, ["show", "HEAD:docs/ecosystem.generated.yaml"]);
      const committedDigest = createHash("sha256").update(blob.stdout, "utf8").digest("hex");
      if (blob.exitCode !== 0 || committedDigest !== manifestDigest) {
        return {
          refused: true,
          message:
            "post-rebase regeneration: committed ecosystem manifest differs from the generated bytes",
          fixHint: "inspect the manifest and worktree before re-running flow.integrate",
        };
      }
    }
    input.onProgress?.("post-rebase regeneration: no drift");
    if (input.baseSha !== undefined) {
      await writePostRebaseRegenRecord(branchWorktree, io, {
        baseSha: input.baseSha,
        ownedPaths: [...owned],
        onProgress: input.onProgress,
      });
    }
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
  if (manifestDigest !== undefined) {
    const blob = await git(branchWorktree, io, ["show", "HEAD:docs/ecosystem.generated.yaml"]);
    const committedDigest = createHash("sha256").update(blob.stdout, "utf8").digest("hex");
    if (blob.exitCode !== 0 || committedDigest !== manifestDigest) {
      return {
        refused: true,
        message:
          "post-rebase regeneration: committed ecosystem manifest differs from the generated bytes",
        fixHint: "inspect the regeneration commit before re-running flow.integrate",
      };
    }
  }
  input.onProgress?.(
    `post-rebase regeneration: committed ${committed.join(", ")} (${sha.slice(0, 9)})`,
  );
  if (input.baseSha !== undefined) {
    await writePostRebaseRegenRecord(branchWorktree, io, {
      baseSha: input.baseSha,
      ownedPaths: [...owned],
      onProgress: input.onProgress,
    });
  }
  return { ran, committed, sha };
}
