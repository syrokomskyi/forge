/*
<MODULE_CONTRACT>
<purpose>
Tracked lockfile restoration — after a mission lifecycle step runs `pnpm install`
for dependency pruning, the local install may rewrite `pnpm-lock.yaml`. That churn
is local mission state and must never land in tracked artifacts: this helper
restores the file committed at HEAD so the worktree returns clean.
</purpose>
<non-goals>
  <item>Does not commit, stage, or delete the lockfile — only restores tracked bytes.</item>
  <item>Does not synthesize a lockfile when HEAD carries none — returns false and changes nothing.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1505: steps 3-5 — tracked lockfile restore, no side-effect commits</item>
  <item>RFC-1505: review r1 — durable projections and lockfile restore hardening</item>
  <item>RFC-1505: review r2 — clone-only sternsystem enumeration and mission-gated lockfile net</item>
  <item>RFC-1544: attribute mission lockfile churn to owning checkout and auto-resolve foreign importer diffs (RFC-1544)</item>
  <item>RFC-1616: close r19 counterexamples CX-166 through CX-171</item>
  <history>RFC-1505</history>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { execFileSync } from "../../src/utils/sync-fs.ts";
import type { ExecOptions, ExecResult, WorkspaceIO } from "../../src/types.ts";
import {
  closeEvidenceIndex,
  evidenceAnchoredGit,
  evidenceRepoPreflight,
  verifierGit,
} from "../../src/utils/verifier-git.ts";
import { extractImporterBlock, removeImporterBlock } from "./importer-block.ts";

const LOCKFILE_NAME = "pnpm-lock.yaml";

/**
 * Restore `pnpm-lock.yaml` to the bytes committed at HEAD.
 *
 * Runs `git show HEAD:pnpm-lock.yaml` in `root`. On exit 0 the stdout is written
 * back over `root/pnpm-lock.yaml` and the call returns `true`. On a non-zero
 * exit (no such file at HEAD, not a git repository) it returns `false` and
 * changes nothing. Spawn failures (missing git binary) propagate.
 * `root` is the repository root — git resolves `HEAD:pnpm-lock.yaml` against
 * the enclosing repo's top level, so passing a nested directory of a larger
 * repo would restore that repo's root lockfile instead.
 */
export async function restoreTrackedLockfile(
  root: string,
  io: Pick<WorkspaceIO, "exec" | "writeFile">,
): Promise<boolean> {
  // The committed-bytes read goes through the judged channel — the
  // ambient exec layer inherits `process.env`, so a session `GIT_DIR`
  // would serve `HEAD:` from a foreign object store and this "restore"
  // would write forged bytes into the real worktree (CX-164). A refused
  // read restores nothing and reports false.
  const res = await verifierGit(root, ["show", `HEAD:${LOCKFILE_NAME}`]);
  if (res.exitCode !== 0) return false;
  await io.writeFile(path.join(root, LOCKFILE_NAME), res.stdout);
  return true;
}

/**
 * Sync-world adapter for `io.exec` — wraps `execFileSync` so handlers that still
 * run on `execSync`/`execFileSync` (e.g. mission.archive) can call
 * `restoreTrackedLockfile` without duplicating its logic. A non-zero exit maps
 * to `exitCode`; a spawn failure (missing binary) keeps throwing.
 */
export function execFileSyncAdapter(): Pick<WorkspaceIO, "exec"> {
  return {
    exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
      try {
        const stdout = execFileSync(command, args, {
          cwd: opts?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: opts?.timeoutMs,
          // Real pnpm-lock.yaml files exceed the 1 MiB default many times over —
          // an ENOBUFS kill carries status null and would rethrow below.
          maxBuffer: 64 * 1024 * 1024,
        });
        return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
      } catch (err) {
        const e = err as {
          status?: number | null;
          stdout?: Buffer | string;
          stderr?: Buffer | string;
        };
        if (e.status === undefined || e.status === null) throw err;
        return Promise.resolve({
          exitCode: e.status,
          stdout: e.stdout?.toString() ?? "",
          stderr: e.stderr?.toString() ?? "",
        });
      }
    },
  };
}

/**
 * RFC-1544 AC-5: drop the listed missions' `missions/<id>/workpiece`
 * importer subtrees from the tracked `pnpm-lock.yaml` and stage the result
 * for the archive bookkeeping commit. The written bytes are HEAD-minus-
 * importers — the post-archive `pnpm install` may churn unrelated lockfile
 * state, and only the importer removal is legitimate tracked change, so
 * everything else is discarded exactly like `restoreTrackedLockfile` did.
 *
 * Returns `pruned` = mission ids whose importer block was actually removed;
 * `staged` = whether `pnpm-lock.yaml` reached the index. When no listed
 * importer exists at HEAD the tracked file is restored instead (the old
 * churn-discard behavior) and `staged` stays false.
 */
export async function pruneMissionImportersFromLockfile(
  root: string,
  missionIds: string[],
  io: Pick<WorkspaceIO, "exec" | "writeFile">,
): Promise<{ pruned: string[]; staged: boolean }> {
  // One preflight anchors the whole read→write→stage sequence: a `.git`
  // indirection swap landing between the judged `show` and the `add`
  // re-points the staging target into a foreign index, and a fresh
  // preflight would happily attest THAT repo — the anchored fingerprint
  // is re-proved immediately before the mutation and any drift refuses
  // (CX-169). The `show` read itself runs on the same anchored surface.
  const preflight = await evidenceRepoPreflight(root);
  if (preflight === null) return { pruned: [], staged: false };
  try {
    // Judged channel for the committed-bytes read — same CX-164
    // redirect: ambient `GIT_DIR` would serve the foreign repo's
    // lockfile bytes.
    const head = await verifierGit(root, ["show", `HEAD:${LOCKFILE_NAME}`], { preflight });
    if (head.exitCode !== 0) return { pruned: [], staged: false };
    let next = head.stdout;
    const pruned: string[] = [];
    for (const missionId of missionIds) {
      const key = `missions/${missionId}/workpiece`;
      if (extractImporterBlock(next, key) === null) continue;
      next = removeImporterBlock(next, key);
      pruned.push(missionId);
    }
    const target = path.join(root, LOCKFILE_NAME);
    if (pruned.length === 0) {
      // Nothing legitimately prunes — keep the discard-churn restore.
      await io.writeFile(target, head.stdout);
      return { pruned, staged: false };
    }
    await io.writeFile(target, next);
    const add = await evidenceAnchoredGit(root, ["add", "--", LOCKFILE_NAME], { preflight });
    return { pruned, staged: add.exitCode === 0 };
  } finally {
    closeEvidenceIndex(preflight);
  }
}
