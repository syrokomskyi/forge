/*
<MODULE_CONTRACT>
<purpose>Thin handler for werkstatt.session.open (RFC-1462) — delegates to the engine session-worktree API.</purpose>
<non-goals>
  <item>No session logic here — packages/werkstatt-engine/src/werkstatt/session-worktree.ts owns it.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { loadSessionEngine } from "./session-engine.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — workspace dep, may not be installed when forge is used standalone from npm
import type { SessionEntry } from "@warpgogol/werkstatt-engine/werkstatt";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";

export interface SessionOpenData {
  command: "werkstatt.session.open";
  status: "ok";
  session: SessionEntry;
  adopted: boolean;
}

export async function runSessionOpen(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SessionOpenData>> {
  const agent = input.flags["agent"] as string | undefined;
  if (!agent) {
    throw new Error("werkstatt.session.open requires --agent <id>");
  }
  const brief = input.flags["brief"] as string | undefined;
  const resume = input.flags["resume"] === true;

  const engine = await loadSessionEngine();
  const result = await engine.sessionOpen(context.io ?? ambientIo, context.workspaceRoot, {
    agent,
    brief,
    resume,
  });
  if (context.outputFormat === "pretty") {
    context.logger.success(
      `${result.adopted ? "Re-adopted" : "Opened"} session ${result.session.id} → ${result.session.worktree} (branch ${result.session.branch})`,
    );
  }
  return {
    data: {
      command: "werkstatt.session.open",
      status: "ok",
      session: result.session,
      adopted: result.adopted,
    },
    summary: `${result.adopted ? "Re-adopted" : "Opened"} session ${result.session.id} — worktree ${result.session.worktree}`,
    nextSteps: [
      {
        action: `Work inside ${result.session.worktree}; close with werkstatt.session.close --session ${result.session.id} --merge`,
        kind: "required",
      },
    ],
  };
}
