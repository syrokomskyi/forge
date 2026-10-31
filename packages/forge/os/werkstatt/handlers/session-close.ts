/*
<MODULE_CONTRACT>
<purpose>Thin handler for werkstatt.session.close (RFC-1462) — delegates to the engine session-worktree API; rerun-safe on closed sessions.</purpose>
<non-goals>
  <item>No session logic here — packages/werkstatt-engine/src/werkstatt/session-worktree.ts owns it.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { sessionClose } from "@warpgogol/werkstatt-engine/werkstatt";
import type { SessionEntry } from "@warpgogol/werkstatt-engine/werkstatt";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";

export interface SessionCloseData {
  command: "werkstatt.session.close";
  status: "ok";
  session: SessionEntry;
  merged: boolean;
  discarded: boolean;
  conflicted: boolean;
  conflictFiles: string[];
}

export async function runSessionClose(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SessionCloseData>> {
  const session = input.flags["session"] as string | undefined;
  if (!session) {
    throw new Error("werkstatt.session.close requires --session <id>");
  }
  if (input.flags["discard"] === true && input.flags["merge"] === true) {
    throw new Error("werkstatt.session.close: --merge and --discard are mutually exclusive");
  }
  const mode = input.flags["discard"] === true ? "discard" : "merge";
  const allowDirty = input.flags["allow-dirty"] === true;
  const into = input.flags["into"] as string | undefined;

  const result = await sessionClose((context.io ?? ambientIo), context.workspaceRoot, {
    session,
    mode,
    allowDirty,
    into,
  });
  if (context.outputFormat === "pretty") {
    if (result.conflicted) {
      context.logger.warn(
        `Merge conflict — worktree kept at ${result.session.worktree}; conflicting: ${result.conflictFiles.join(", ")}`,
      );
    } else {
      context.logger.success(
        `Closed session ${result.session.id} (${result.merged ? "merged" : result.discarded ? "discarded" : "already closed"})`,
      );
    }
  }
  return {
    data: {
      command: "werkstatt.session.close",
      status: "ok",
      session: result.session,
      merged: result.merged,
      discarded: result.discarded,
      conflicted: result.conflicted,
      conflictFiles: result.conflictFiles,
    },
    summary: result.conflicted
      ? `session ${result.session.id} merge-conflict — ${result.conflictFiles.length} file(s), worktree kept`
      : `Closed session ${result.session.id}`,
    exitCode: result.conflicted ? 1 : 0,
  };
}
