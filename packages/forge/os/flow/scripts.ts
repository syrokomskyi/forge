/*
<MODULE_CONTRACT>
<purpose>Repository hook-script runner for the session lifecycle (RFC-1487):
worktree-setup.sh, integration-gate.sh and worktree-teardown.sh are optional
repository conventions executed from the PRIMARY worktree — never from the
branch worktree, so a session cannot weaken its own gate — with cwd set to
the branch worktree and the declared FLOW_* environment.</purpose>
<non-goals>
  <item>No lifecycle decisions — handlers map a non-zero exit to their own diagnostics.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Scripts run as `sh &lt;primary&gt;/hooks/&lt;name&gt;.sh` through io.exec with an argument vector — no shell interpolation (DNA-89, AUDIT-RFC-1487-G1).</item>
  <item>Absent script → skipped; a script present in the branch worktree but absent in the primary is skipped identically — only develop's version gates.</item>
  <item>stderrTail is the last 40 lines — enough for the report without flooding it (DNA-106).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 2 — primary-side hook-script runner</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";

export type FlowScriptName =
  | "worktree-setup"
  | "integration-gate"
  | "worktree-teardown";

export interface FlowScriptResult {
  status: "done" | "skipped" | "failed";
  exitCode: number | null;
  stderrTail: string;
}

const STDERR_TAIL_LINES = 40;

/**
 * Run `<primary>/hooks/<name>.sh` with cwd inside `cwd` (the branch
 * worktree). The script bytes always come from the primary checkout — the
 * develop version, already integrated.
 */
export async function runFlowScript(
  io: WorkspaceIO,
  name: FlowScriptName,
  opts: { primary: string; cwd: string; env: Record<string, string> },
): Promise<FlowScriptResult> {
  const scriptPath = join(opts.primary, "hooks", `${name}.sh`);
  if (!(await io.exists(scriptPath))) {
    return { status: "skipped", exitCode: null, stderrTail: "" };
  }
  const result = await io.exec("sh", [scriptPath], { cwd: opts.cwd, env: opts.env });
  const tail = result.stderr
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-STDERR_TAIL_LINES)
    .join("\n");
  return result.exitCode === 0
    ? { status: "done", exitCode: result.exitCode, stderrTail: tail }
    : { status: "failed", exitCode: result.exitCode, stderrTail: tail };
}
