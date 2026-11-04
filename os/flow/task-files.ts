/*
<MODULE_CONTRACT>
<purpose>Preserve a task worktree's .forge/task/ payload into the common git
dir before flow.integrate / flow.discard removes the worktree (RFC-1509
Q-15/Q-16). The task report then survives teardown — system.task.collect
reads it from &lt;common&gt;/forge/tasks/&lt;owner id&gt;/ once the worktree
is gone. Copies are idempotent (same owner id re-copies over).</purpose>
<non-goals>
  <item>No report validation — collect owns forge/task-report@1 checks.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1509: step 4 — preserve .forge/task/ under the common git dir</item>
  <item>RFC-1509: implement RFC-1509 — system task queue, dispatch briefs and task reports</item>
  <item>RFC-1509: close RFC-1509 review r1 findings — mark-failed escape, open-error refusal, dry-run coverage</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";

/** Directory inside a task worktree that carries brief/report payloads. */
export const TASK_FILES_DIR = ".forge/task";

async function copyTree(src: string, dst: string, io: WorkspaceIO, into: string[]): Promise<void> {
  for (const entry of await io.readdir(src)) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory) {
      await io.mkdir(d);
      await copyTree(s, d, io, into);
    } else if (entry.isFile) {
      await io.copyFile(s, d);
      into.push(d);
    }
  }
}

/**
 * Copy `<worktree>/.forge/task/` to `<commonGitDir>/forge/tasks/<ownerId>/`
 * (recursive — subdirectories are preserved). Returns the copied file paths;
 * an absent source directory is a no-op — a task branch is allowed to end
 * without a report (collect then reports SYSTEM-TASK-07).
 */
export async function preserveTaskFiles(
  commonGitDir: string,
  worktree: string,
  ownerId: string,
  io: WorkspaceIO,
): Promise<string[]> {
  const src = join(worktree, TASK_FILES_DIR);
  if (!(await io.exists(src))) return [];
  const dst = join(commonGitDir, "forge", "tasks", ownerId);
  await io.mkdir(dst);
  const copied: string[] = [];
  await copyTree(src, dst, io, copied);
  return copied;
}
