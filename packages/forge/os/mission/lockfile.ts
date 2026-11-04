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
  <item>RFC-1505: step 3 — tracked lockfile restore helper</item>
  <item>RFC-1505: steps 3-5 — tracked lockfile restore, no side-effect commits</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { execFileSync } from "../../src/utils/sync-fs.ts";
import type { ExecOptions, ExecResult, WorkspaceIO } from "../../src/types.ts";

const LOCKFILE_NAME = "pnpm-lock.yaml";

/**
 * Restore `pnpm-lock.yaml` to the bytes committed at HEAD.
 *
 * Runs `git show HEAD:pnpm-lock.yaml` in `root`. On exit 0 the stdout is written
 * back over `root/pnpm-lock.yaml` and the call returns `true`. On a non-zero
 * exit (no such file at HEAD, not a git repository) it returns `false` and
 * changes nothing. Spawn failures (missing git binary) propagate.
 */
export async function restoreTrackedLockfile(
  root: string,
  io: Pick<WorkspaceIO, "exec" | "writeFile">,
): Promise<boolean> {
  const res = await io.exec("git", ["show", `HEAD:${LOCKFILE_NAME}`], { cwd: root });
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
