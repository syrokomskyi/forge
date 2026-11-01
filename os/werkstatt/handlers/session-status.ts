/*
<MODULE_CONTRACT>
<purpose>Thin handler for werkstatt.session.status (RFC-1462) — lists live sessions, dirty counts, staleness; all state is filesystem/gitdir so it survives a dead agent.</purpose>
<non-goals>
  <item>No session logic here — packages/werkstatt-engine/src/werkstatt/session-worktree.ts owns it.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { loadSessionEngine } from "./session-engine.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — workspace dep, may not be installed when forge is used standalone from npm
import type { SessionStatusEntry } from "@warpgogol/werkstatt-engine/werkstatt";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";

export interface SessionStatusData {
  command: "werkstatt.session.status";
  status: "ok";
  sessions: SessionStatusEntry[];
}

export async function runSessionStatus(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SessionStatusData>> {
  const staleAfterFlag = input.flags["stale-after"];
  const staleAfterMs =
    typeof staleAfterFlag === "string" ? Number(staleAfterFlag) * 60_000 : undefined;
  const engine = await loadSessionEngine();
  const sessions = await engine.sessionStatus((context.io ?? ambientIo), context.workspaceRoot, {
    staleAfterMs: Number.isFinite(staleAfterMs) ? staleAfterMs : undefined,
  });
  if (context.outputFormat === "pretty") {
    if (sessions.length === 0) {
      context.logger.info("No sessions registered.");
    }
    for (const s of sessions) {
      context.logger.info(
        `${s.id} [${s.status}] ${s.worktree} — dirty:${s.dirtyCount}${s.stale ? " STALE" : ""} (base ${s.baseBranch})`,
      );
    }
  }
  return {
    data: { command: "werkstatt.session.status", status: "ok", sessions },
    summary: `${sessions.length} session(s)`,
  };
}
