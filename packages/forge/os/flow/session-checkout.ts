/*
<MODULE_CONTRACT>
<purpose>RFC-1536: owning-checkout resolution for session-artifact writes.
Commands that produce durable session artifacts (session.save, docs.archive,
…) must write into the checkout that owns the session — the registered
auto/* worktree — instead of trusting cwd. This module decides which
checkout owns a write, given the invocation cwd.</purpose>
<non-goals>
  <item>No cross-clone attribution — the registry lives in the common git dir; a different clone is invisible by design (bounded consequence, RFC-1536 failure modes).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Attribution precedence: the registry `owner` field is authoritative (durable, lock-written at flow.open); the WERKSTATT_AGENT_ID env is only a fallback hint for pre-registry contexts. Disagreement between the two is a refusal, never a guess.</item>
  <item>Exactly one live session worktree is unambiguous attribution — an owner.id of "unspecified" still routes, because no other session can own the write.</item>
  <item>No registered session worktree at all → kind "primary" — the solo primary flow that worked before keeps working (degrade, never block).</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1536: owning-checkout resolution for session-artifact writes</item>
  <item>RFC-1536: owning-checkout routing, FLOW-OPEN-01 dirty-primary warning, shared governance-id allocation (RFC+ADR)</item>
  <item>RFC-1536: session-checkout bare-repo degrade to primary semantics</item>
  <item>RFC-1536: type forge flow and rfc io against forge's own WorkspaceIO

The standalone forge extract has no @warpgogol/werkstatt-shared; the type-only import failed extract-verify (FLOW-CUT-13) for the 9.4.0 cut.</item>
</CHANGE_SUMMARY>
*/

import { realpath } from "node:fs/promises";

import type { WorkspaceIO } from "../../src/types.ts";

import { topLevel } from "./git.ts";
import { commonGitDir, readRegistry, type FlowRegistryEntry } from "./registry.ts";
import { primaryWorktree } from "./worktree-path.ts";

export interface OwningCheckout {
  kind: "primary" | "worktree";
  /** Registered worktree path owning the writes — set when kind === "worktree". */
  worktreePath?: string;
  /** Registered auto/* branch owning the writes — set when kind === "worktree". */
  sessionBranch?: string;
}

export type OwningCheckoutResult =
  | { ok: true; checkout: OwningCheckout; warnings: string[] }
  | {
      ok: false;
      /** SESSION-WRITE-01 detail — registered session worktrees exist but none is attributable. */
      reason: string;
      candidates: string[];
    };

/** Env hints consulted for attribution, strongest first. */
const AGENT_ID_ENV = ["WERKSTATT_AGENT_ID", "AI_AGENT"] as const;

function agentIdHint(): string | null {
  for (const name of AGENT_ID_ENV) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

async function samePath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return a === b;
  }
}

/** Live session entries: kind session, a worktree path that still exists. */
async function liveSessionEntries(
  io: WorkspaceIO,
  entries: FlowRegistryEntry[],
): Promise<FlowRegistryEntry[]> {
  const live: FlowRegistryEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "session" || entry.worktree === null) continue;
    if (await io.exists(entry.worktree)) live.push(entry);
  }
  return live;
}

/**
 * Decide which checkout owns a session-artifact write invoked at `cwd`.
 *
 * - cwd inside a registered worktree → that worktree (the write already lands
 *   in the owning checkout; callers keep their cwd-relative behavior).
 * - cwd == primary (or anywhere outside registered worktrees):
 *     - an explicit sessionId / env hint matching exactly one entry → route;
 *     - a hint matching nothing while session worktrees exist → refuse (the
 *       registry is authoritative; disagreement is never resolved by guess);
 *     - no hint: exactly one live session worktree → route; more → refuse;
 *     - zero live session worktrees → primary (degrade).
 * - Registry read failure → primary with a warning (solo flow keeps working).
 */
export async function resolveOwningCheckout(
  io: WorkspaceIO,
  cwd: string,
  sessionId?: string,
): Promise<OwningCheckoutResult> {
  const warnings: string[] = [];
  const repoRoot = await topLevel(cwd, io);
  if (repoRoot === null) {
    return { ok: true, checkout: { kind: "primary" }, warnings };
  }

  let entries: FlowRegistryEntry[];
  try {
    const common = await commonGitDir(io, repoRoot);
    const registry = await readRegistry(io, common);
    entries = registry.branches;
  } catch (error) {
    warnings.push(
      `flow registry unreadable — degrading to cwd semantics: ${(error as Error).message}`,
    );
    return { ok: true, checkout: { kind: "primary" }, warnings };
  }

  for (const entry of entries) {
    if (entry.worktree !== null && (await samePath(cwd, entry.worktree))) {
      return {
        ok: true,
        checkout: { kind: "worktree", worktreePath: entry.worktree, sessionBranch: entry.name },
        warnings,
      };
    }
  }

  const live = await liveSessionEntries(io, entries);
  if (live.length === 0) {
    return { ok: true, checkout: { kind: "primary" }, warnings };
  }

  let primary: string;
  try {
    primary = await primaryWorktree(io, repoRoot);
  } catch {
    // Bare repo or unreadable worktree list — keep cwd semantics.
    return { ok: true, checkout: { kind: "primary" }, warnings };
  }
  if (!(await samePath(cwd, primary))) {
    // cwd is neither a registered worktree nor the primary — a bare/other
    // checkout the flow model does not govern; keep cwd semantics.
    return { ok: true, checkout: { kind: "primary" }, warnings };
  }

  const hint = sessionId ?? agentIdHint();
  if (hint !== null) {
    const matched = live.filter((e) => e.owner.id === hint);
    if (matched.length === 1) {
      return {
        ok: true,
        checkout: {
          kind: "worktree",
          worktreePath: matched[0].worktree ?? undefined,
          sessionBranch: matched[0].name,
        },
        warnings,
      };
    }
    return {
      ok: false,
      reason: `session hint '${hint}' matches ${matched.length} of ${live.length} live session worktree(s) — registry owner is authoritative`,
      candidates: live.map((e) => `${e.name} (owner ${e.owner.id})`),
    };
  }

  if (live.length === 1) {
    return {
      ok: true,
      checkout: {
        kind: "worktree",
        worktreePath: live[0].worktree ?? undefined,
        sessionBranch: live[0].name,
      },
      warnings,
    };
  }

  return {
    ok: false,
    reason: `${live.length} live session worktrees and no session hint — cannot attribute the write`,
    candidates: live.map((e) => `${e.name} (owner ${e.owner.id})`),
  };
}
