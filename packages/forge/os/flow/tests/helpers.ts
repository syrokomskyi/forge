/*
<MODULE_CONTRACT>
<purpose>Throwaway-repository scaffolding for os/flow tests (RFC-1486): every
git command runs inside a fresh repo under the OS temp dir — never against the
enclosing workspace — and the guard hook is installed exactly the way
flow.install does it (committed hooks dir + core.hooksPath).</purpose>
<non-goals>
  <item>No production code — test scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Hooks live in &lt;repo&gt;/hooks (committed), never .git/hooks — worktrees check out committed content (AUDIT-RFC-1486-G1).</item>
  <item>FORGE_FLOW_OP is always set explicitly ("" for the unset cases) so a leaked outer value cannot make tests non-deterministic.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 2 — POSIX guard asset + behavior/parity tests</item>
  <item>RFC-1486: step 3 — flow.check with FLOW-01..05 + managed-block helpers</item>
  <item>RFC-1486: review r1 — committed-state adoption gate, uncommitted-hook committedness, step-failure trail, idempotency declaration, lazy asset resolution</item>
  <item>RFC-1490: pre-merge-commit guard mode + per-mode op vocabulary; amends the wave-1 guard RFC's backmerge escape (AC-11)</item>
  <item>RFC-1491: step 2 — pre-push guard mode, install steps pre-push + markers, FLOW-10</item>
  <history>RFC-1486</history>
</CHANGE_SUMMARY>
*/

import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecResult } from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import {
  GUARD_BEGIN_MARKER,
  GUARD_END_MARKER,
  MANAGED_BLOCK,
  managedBlock,
  resolveGuardAssetPath,
} from "../guard-files.ts";

const PREMERGE_MANAGED_BLOCK = managedBlock("pre-merge-commit");
const PREPUSH_MANAGED_BLOCK = managedBlock("pre-push");

export {
  GUARD_BEGIN_MARKER,
  GUARD_END_MARKER,
  MANAGED_BLOCK,
};

/** Absolute path of the shipped guard asset — resolved on first use. */
export const GUARD_ASSET = resolveGuardAssetPath();

export function gitExec(
  repo: string,
  args: string[],
  env?: Record<string, string>,
): Promise<ExecResult> {
  return ambientIo.exec("git", ["-C", repo, ...args], { env });
}

/**
 * `git init` in a fresh temp dir with deterministic local config (no global
 * git config may leak in). `seedCommit` creates a root commit — skipped for
 * unborn-HEAD cases.
 */
export async function initRepo(opts?: {
  branch?: string;
  seedCommit?: boolean;
  prefix?: string;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), opts?.prefix ?? "flow-test-"));
  const init = await gitExec(dir, ["init", "-b", opts?.branch ?? "main"]);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
  await gitExec(dir, ["config", "user.email", "flow-test@example.invalid"]);
  await gitExec(dir, ["config", "user.name", "flow-test"]);
  await gitExec(dir, ["config", "commit.gpgsign", "false"]);
  if (opts?.seedCommit !== false) {
    await writeFile(join(dir, "seed.txt"), "seed\n");
    await gitExec(dir, ["add", "seed.txt"]);
    const seed = await gitExec(dir, ["commit", "-m", "seed"]);
    if (seed.exitCode !== 0) throw new Error(`seed commit failed: ${seed.stderr}`);
  }
  return dir;
}

/**
 * Install the guard the way flow.install does it: hooks/flow-guard.sh byte
 * copy of the asset, hooks/pre-commit carrying the managed block right after
 * the shebang, core.hooksPath pointing at the committed dir.
 */
export async function installGuard(repo: string): Promise<void> {
  const hooksDir = join(repo, "hooks");
  await mkdir(hooksDir, { recursive: true });
  await copyFile(resolveGuardAssetPath(), join(hooksDir, "flow-guard.sh"));
  await writeFile(join(hooksDir, "pre-commit"), `#!/bin/sh\n${MANAGED_BLOCK}`);
  await writeFile(join(hooksDir, "pre-merge-commit"), `#!/bin/sh\n${PREMERGE_MANAGED_BLOCK}`);
  await writeFile(join(hooksDir, "pre-push"), `#!/bin/sh\n${PREPUSH_MANAGED_BLOCK}`);
  await chmod(join(hooksDir, "flow-guard.sh"), 0o755);
  await chmod(join(hooksDir, "pre-commit"), 0o755);
  await chmod(join(hooksDir, "pre-merge-commit"), 0o755);
  await chmod(join(hooksDir, "pre-push"), 0o755);
  const hooksPath = await gitExec(repo, ["config", "core.hooksPath", "hooks"]);
  if (hooksPath.exitCode !== 0) {
    throw new Error(`core.hooksPath failed: ${hooksPath.stderr}`);
  }
}

/** Attempt a commit; env overrides merge over process.env (set "" to neutralize). */
export function tryCommit(
  repo: string,
  env?: Record<string, string>,
): Promise<ExecResult> {
  return gitExec(repo, ["commit", "--allow-empty", "-m", "probe"], env);
}

/** Invoke the installed guard directly with HEAD on the current branch. */
export function runGuardDirect(
  repo: string,
  env?: Record<string, string>,
): Promise<ExecResult> {
  return ambientIo.exec("sh", [join(repo, "hooks", "flow-guard.sh"), "pre-commit"], {
    cwd: repo,
    env,
  });
}

/** Switch to a branch, creating it when it does not exist yet. */
export async function checkoutOrCreate(repo: string, name: string): Promise<void> {
  const exists =
    (await gitExec(repo, ["branch", "--list", name])).stdout.trim().length > 0;
  const result = exists
    ? await gitExec(repo, ["switch", name])
    : await gitExec(repo, ["switch", "-c", name]);
  if (result.exitCode !== 0) {
    throw new Error(`switch to ${name} failed: ${result.stderr}`);
  }
}
