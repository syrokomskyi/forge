/*
<MODULE_CONTRACT>
<purpose>werkstatt.lock.status command handler. Moved from
@warpgogol/site-kernel-handoff to @warpgogol/forge for full autonomous mode (RFC-0556).
Reports all Werkstatt locks, their age, owner, and staleness (RFC-0362).</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0362: initial lock.status command handler.</item>
  <item>RFC-0556: moved from @warpgogol/site-kernel-handoff to @warpgogol/forge for autonomous mode.</item>
</CHANGE_SUMMARY>
*/

import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { readAllLocks } from "./lock.ts";

export interface WerkstattLockStatusData {
  locks: Array<{
    scope: string;
    operationId: string;
    command: string;
    owner: string;
    pid: number;
    startedAt: string;
    heartbeatAt: string;
    timeoutSeconds: number;
    stale: boolean;
  }>;
  count: number;
  staleCount: number;
}

export async function runWerkstattLockStatus(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<WerkstattLockStatusData>> {
  const { workspaceRoot, logger } = context;
  const locks = await readAllLocks(workspaceRoot);

  const staleCount = locks.filter((l) => l.stale).length;

  for (const lock of locks) {
    const status = lock.stale ? "STALE" : "active";
    logger.info(
      `  ${lock.scope.padEnd(32)} ${status.padEnd(6)} pid:${lock.pid} op:${lock.operationId}`,
    );
  }

  return {
    data: {
      locks: locks.map((l) => ({
        scope: l.scope,
        operationId: l.operationId,
        command: l.command,
        owner: l.owner,
        pid: l.pid,
        startedAt: l.startedAt,
        heartbeatAt: l.heartbeatAt,
        timeoutSeconds: l.timeoutSeconds,
        stale: l.stale,
      })),
      count: locks.length,
      staleCount,
    },
    summary: `[werkstatt.lock.status] ${locks.length} lock${locks.length === 1 ? "" : "s"}, ${staleCount} stale`,
  };
}
