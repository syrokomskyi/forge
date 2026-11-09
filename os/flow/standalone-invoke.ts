/*
<MODULE_CONTRACT>
<purpose>Standalone invoke adapter for flow handlers (RFC-1545) — when no
kernel invoke port is present, generated-owner regeneration commands still
run by spawning `pnpm exec werkstatt run <command>` inside the session
worktree, allowlisted to the declared generated-path owners only.</purpose>
<non-goals>
  <item>No in-process dispatch — forge's standalone registry builder lives in bin/cli.ts and is not an os/ seam; the spawn contract keeps the adapter kernel-free (FORGE-AUTONOMY-01).</item>
  <item>No free-form command execution — only owner commands recovered from generated-path declarations/markers may run, and flow.integrate is excluded (no re-entrant recursion).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Spawn over in-process dispatch: the kernel invoke port delegates through its own executor, but the standalone CLI has no registry surface reachable from os/ — `pnpm exec werkstatt run` resolves the worktree's own engine build, matching how an operator would run the owner command by hand.</item>
  <item>The allowlist is caller-derived (verdict.owners), not a static table — classifyRebaseConflicts only ever names commands recovered from generated markers or GENERATED_BASENAME_OWNERS, so the spawn surface stays bounded by the declaration layer.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1545: standalone invoke adapter for declared-generated rebase conflict regeneration under the forge CLI</item>
  <item>RFC-1545: standalone generated-conflict regeneration in flow.integrate</item>
</CHANGE_SUMMARY>
*/

import type {
  ExecResult,
  ForgeFlagValue,
  ForgeInvokeCommand,
  WorkspaceIO,
} from "../../src/types.ts";

/** Serialize the flag record to argv — `true` → `--key`, `false` → `--no-key`, strings/arrays → `--key value`. */
function flagArgs(flags?: Record<string, ForgeFlagValue>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(flags ?? {})) {
    if (value === true) args.push(`--${key}`);
    else if (value === false) args.push(`--no-${key}`);
    else if (Array.isArray(value)) for (const v of value) args.push(`--${key}`, v);
    else args.push(`--${key}`, String(value));
  }
  return args;
}

/**
 * RFC-1545 AC-2: `ForgeInvokeCommand` for the standalone `forge` CLI —
 * resolves each allowlisted owner command through `pnpm exec werkstatt run`
 * spawned in the session worktree (the worktree's own dependency graph
 * decides which werkstatt build answers). Non-allowlisted commands fail
 * closed; a spawn failure or non-zero exit surfaces as a ForgeInvokeResult
 * the caller escalates to FLOW-INT-02.
 */
export function standaloneInvoke(
  io: WorkspaceIO,
  worktreePath: string,
  allowedCommands: readonly string[],
): ForgeInvokeCommand {
  const allowlist = new Set(allowedCommands);
  return async (commandName, flags) => {
    if (commandName === "flow.integrate" || !allowlist.has(commandName)) {
      return {
        exitCode: 1,
        ok: false,
        summary: `${commandName} is not in the generated-owner allowlist — refusing standalone invocation`,
      };
    }
    let result: ExecResult;
    try {
      result = await io.exec(
        "pnpm",
        ["exec", "werkstatt", "run", commandName, ...flagArgs(flags)],
        { cwd: worktreePath },
      );
    } catch (error) {
      return {
        exitCode: 1,
        ok: false,
        summary: `standalone invoke of ${commandName} failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const exitCode = result.exitCode ?? 1;
    const tail = (result.stderr.trim() || result.stdout.trim()).split("\n").pop() ?? "";
    return {
      exitCode,
      ok: exitCode === 0,
      summary: tail || `exit ${exitCode}`,
    };
  };
}
