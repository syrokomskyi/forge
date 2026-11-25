/*
<MODULE_CONTRACT>
<purpose>Generic tracked-lockfile hygiene — restore pnpm-lock.yaml to HEAD bytes through the judged git channel, plus a sync-world exec adapter. Absorbed from the v9 os/mission module during the v10 core transfer (Werkstatt RFC-1649); mission-specific importer pruning stayed studio-private and did not transfer.</purpose>
<non-goals>
  <item>No mission/studio layout knowledge — this module is layout-generic.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import path from "node:path";
import { execFileSync } from "./sync-fs.ts";
import type { ExecOptions, ExecResult, WorkspaceIO } from "../types.ts";
import { verifierGit } from "./verifier-git.ts";

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
