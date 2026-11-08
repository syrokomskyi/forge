/*
<MODULE_CONTRACT>
<purpose>Gate-engine resolution for flow.integrate (RFC-1538): pick the
checkout whose build executes the primary-owned integration-gate.sh. A
session worktree carrying its own engine build (node_modules present) runs
"session" — the gate script stays primary-owned, only the engine binary
context moves so the code under review judges itself. Without a session
build (plain-git workshops, non-session branches) the primary engine stays
the fallback and the run reports FLOW-INT-16 (warning).</purpose>
<non-goals>
  <item>No PATH/env injection — cwd binding alone yields the session build through pnpm/node resolution.</item>
  <item>No check weakening — hook bytes always come from the primary checkout (runFlowScript contract).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1538: session-engine gate selection — GateEngine resolution + FLOW-INT-16 fallback reporting</item>
  <item>RFC-1538: revalidate integration preconditions post-lock and reuse the session engine</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";

import type { WorkspaceIO } from "../../src/types.ts";

export interface GateEngine {
  source: "primary" | "session";
  /** cwd the gate script executes under. */
  root: string;
}

/**
 * "session" when the integrating worktree carries its own engine build —
 * `node_modules` presence is the install marker. Everything else resolves
 * primary (plain-git workshops, branches without an install).
 */
export async function resolveGateEngine(
  branchWorktree: string,
  primary: string,
  io: WorkspaceIO,
): Promise<GateEngine> {
  if (await io.exists(join(branchWorktree, "node_modules"))) {
    return { source: "session", root: branchWorktree };
  }
  return { source: "primary", root: primary };
}
