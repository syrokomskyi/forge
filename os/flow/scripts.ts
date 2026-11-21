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
  <item>Absent script → skipped; branch-only scripts skip identically — only develop's version gates.</item>
  <item>stderrTail is the last 40 lines — enough for the report without flooding it (DNA-106).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
  <item>RFC-1491: step 5 — flow.push atomic outbound path + extract publication</item>
  <item>RFC-1502: step 2 — release-prepare hook name</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <item>RFC-1616: outlive the integration gate's own budgets in the hook spawn cap (RFC-1616 follow-up)</item>
  <history>RFC-1487, RFC-1532</history>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";
import { verifierSpawn } from "../../src/utils/verifier-git.ts";

export type FlowScriptName =
  | "worktree-setup"
  | "integration-gate"
  | "worktree-teardown"
  | "release-prepare"
  | "release-fingerprints"
  | "extract-verify";

export interface FlowScriptResult {
  status: "done" | "skipped" | "failed";
  exitCode: number | null;
  stderrTail: string;
  /** stdout truncated to 64 KiB with a trailing `…[truncated]` marker. */
  stdout: string;
  /** RFC-1532: repo-relative `gate-reports/<file>` parsed from the
   * integration-gate's stdout marker; null when the gate wrote none (or a
   * WT-GATE-07 write failure), absent for other scripts and older gates. */
  reportPath?: string | null;
}

const STDERR_TAIL_LINES = 40;
const STDOUT_CAP = 64 * 1024;

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
    return { status: "skipped", exitCode: null, stderrTail: "", stdout: "" };
  }
  // The gate hook is a trust-boundary subprocess: session env (NODE_OPTIONS,
  // BASH_ENV, a shim PATH dir) must not reach the hook or the forge it spawns
  // (CX-41 class). verifierSpawn replaces the env wholesale — `opts.env`
  // carries caller-owned FLOW_* context only. The spawn cap must outlive the
  // hook's own inner budgets — the integration gate's per-package runs take
  // --timeout 900 and its cold e2e --e2e-timeout 1800, so a 600 s cap turned a
  // legitimately long (all-checks-pass) run into a killed exit -1.
  const result = await verifierSpawn("sh", [scriptPath], {
    cwd: opts.cwd,
    timeoutMs: name === "integration-gate" ? 3_600_000 : 600_000,
    extraEnv: opts.env,
  });
  // A failing hook may report only on stdout (forge commands do); an empty tail
  // would leave the refusal without a reason.
  const tailOf = (text: string): string =>
    text
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-STDERR_TAIL_LINES)
      .join("\n");
  const stderrTail = tailOf(result.stderr);
  const tail = stderrTail === "" && result.exitCode !== 0 ? tailOf(result.stdout) : stderrTail;
  const stdout =
    result.stdout.length > STDOUT_CAP
      ? `${result.stdout.slice(0, STDOUT_CAP)}…[truncated]`
      : result.stdout;
  // RFC-1532: the gate prints `gate-report: <repo-relative path>` on stdout —
  // the only channel through the --quiet hook wrapper.
  const reportPath =
    name === "integration-gate"
      ? (result.stdout.match(/^gate-report: (\S+)\s*$/m)?.[1] ?? null)
      : undefined;
  return result.exitCode === 0
    ? {
        status: "done",
        exitCode: result.exitCode,
        stderrTail: tail,
        stdout,
        ...(reportPath !== undefined ? { reportPath } : {}),
      }
    : {
        status: "failed",
        exitCode: result.exitCode,
        stderrTail: tail,
        stdout,
        ...(reportPath !== undefined ? { reportPath } : {}),
      };
}
