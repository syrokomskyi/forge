/*
<MODULE_CONTRACT>
<purpose>Shared operation-claims registry (RFC-1543) — long-running ops that
write git-visible state in a checkout they do not own journal a
`forge/op-claim@1` record under the shared git dir before mutating, so
`classifyDirt` can attribute otherwise-foreign dirt to a live holder instead
of refusing blind. Liveness (pid alive on this host+bootId, heartbeat
≤5×cadence), not deletion, is authoritative — a crashed op's record is
reclaimed by the next reader, never trusted.</purpose>
<non-goals>
  <item>No cross-host coordination — claims are machine-local, same trust model as integrate.lock.</item>
  <item>No mutation authority — readers may sweep dead records; they never edit claims or block on them directly.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Claims live at &lt;git-common-dir&gt;/forge/ops/&lt;opId&gt;.yaml — worktrees share one git dir, so a claim written from a session worktree is visible to the primary by construction.</item>
  <item>Claim-write failure degrades to unclaimed behavior (fail-safe): the op proceeds and classification keeps the old refusal semantics — a registry outage must never become a write blocker.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1543: op-claim registry — claim/release/liveClaims, pid+bootId+heartbeat liveness, lazy dead-record sweep</item>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
</CHANGE_SUMMARY>
*/

import { hostname } from "node:os";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { WorkspaceIO } from "../../src/types.ts";
import { currentBootId, holderIsDead } from "../core/lock-holder.ts";
import { git } from "./git.ts";

export const OP_CLAIM_SCHEMA = "forge/op-claim@1";
/** Expected heartbeat write cadence — a claim goes stale at 5× this age. */
export const HEARTBEAT_CADENCE_MS = 30_000;

export interface OpClaim {
  schema: typeof OP_CLAIM_SCHEMA;
  opId: string;
  command: string;
  pid: number;
  host: string;
  bootId?: string;
  startedAt: string;
  heartbeatAt: string;
  workspaceRoot: string;
  /** Exact paths or directory prefixes the op legitimately dirties. */
  paths: string[];
}

/** `<git-common-dir>/forge/ops` — shared across linked worktrees. */
async function opsDir(repo: string, io: WorkspaceIO): Promise<string | null> {
  let r;
  try {
    r = await git(repo, io, ["rev-parse", "--git-common-dir"]);
  } catch {
    return null;
  }
  if (r.exitCode !== 0) return null;
  const dir = r.stdout.trim();
  return join(dir.startsWith("/") ? dir : join(repo, dir), "forge", "ops");
}

/** Liveness (AC-2): pid alive on this host+bootId AND heartbeat ≤5×cadence. */
export function isClaimLive(claim: OpClaim, now: number = Date.now()): boolean {
  if (holderIsDead(claim, currentBootId())) return false;
  const beat = Date.parse(claim.heartbeatAt);
  if (!Number.isFinite(beat) || now - beat > 5 * HEARTBEAT_CADENCE_MS) return false;
  return true;
}

/** True when `path` equals or sits under a declared claim path/prefix. */
export function claimCoversPath(claim: OpClaim, path: string): boolean {
  return claim.paths.some((p) => {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    return path === p || path.startsWith(prefix);
  });
}

/** Write a claim before the op's first shared-checkout mutation — best-effort. */
export async function claimOp(
  repo: string,
  io: WorkspaceIO,
  claim: Omit<OpClaim, "schema" | "pid" | "host" | "bootId" | "startedAt" | "heartbeatAt"> & {
    startedAt?: string;
  },
): Promise<boolean> {
  const dir = await opsDir(repo, io);
  if (dir === null) return false;
  const now = new Date().toISOString();
  const record: OpClaim = {
    schema: OP_CLAIM_SCHEMA,
    pid: process.pid,
    host: hostname(),
    bootId: currentBootId(),
    heartbeatAt: now,
    startedAt: claim.startedAt ?? now,
    ...claim,
  };
  try {
    await io.mkdir(dir);
    await io.writeFile(join(dir, `${record.opId}.yaml`), yamlStringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Refresh a live claim's heartbeat — best-effort, same path. */
export async function heartbeatOp(repo: string, io: WorkspaceIO, opId: string): Promise<void> {
  const dir = await opsDir(repo, io);
  if (dir === null) return;
  const file = join(dir, `${opId}.yaml`);
  try {
    const parsed = yamlParse(await io.readFile(file)) as Partial<OpClaim> | null;
    if (!parsed || parsed.schema !== OP_CLAIM_SCHEMA) return;
    parsed.heartbeatAt = new Date().toISOString();
    await io.writeFile(file, yamlStringify(parsed));
  } catch {
    /* best-effort */
  }
}

/** Best-effort removal — liveness, not deletion, is authoritative. */
export async function releaseOp(repo: string, io: WorkspaceIO, opId: string): Promise<void> {
  const dir = await opsDir(repo, io);
  if (dir === null) return;
  try {
    await io.rm(join(dir, `${opId}.yaml`));
  } catch {
    /* already gone */
  }
}

function parseClaim(raw: string): OpClaim | null {
  let parsed: unknown;
  try {
    parsed = yamlParse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<OpClaim>;
  if (
    c.schema !== OP_CLAIM_SCHEMA ||
    typeof c.opId !== "string" ||
    typeof c.command !== "string" ||
    typeof c.pid !== "number" ||
    typeof c.host !== "string" ||
    typeof c.startedAt !== "string" ||
    typeof c.heartbeatAt !== "string" ||
    typeof c.workspaceRoot !== "string" ||
    !Array.isArray(c.paths)
  ) {
    return null;
  }
  return c as OpClaim;
}

/**
 * Live claims for `repo`, sweeping dead/stale records lazily as a side
 * effect. Malformed files sweep too — a record we cannot read cannot be
 * liveness-checked and must never grant tolerance.
 */
async function readClaims(repo: string, io: WorkspaceIO): Promise<{ live: OpClaim[]; dead: string[] }> {
  const dir = await opsDir(repo, io);
  if (dir === null || !(await io.exists(dir))) return { live: [], dead: [] };
  const files = (await io.glob("*.yaml", { cwd: dir })).filter((f) => !f.endsWith("/"));
  const live: OpClaim[] = [];
  const dead: string[] = [];
  for (const f of files) {
    const abs = join(dir, f);
    const claim = parseClaim(await io.readFile(abs));
    if (claim !== null && isClaimLive(claim)) live.push(claim);
    else dead.push(abs);
  }
  return { live, dead };
}

/** Read-only variant for surfaces that must not mutate (flow.peers). */
export async function liveClaimsReadOnly(repo: string, io: WorkspaceIO): Promise<OpClaim[]> {
  return (await readClaims(repo, io)).live;
}

export async function liveClaims(repo: string, io: WorkspaceIO): Promise<OpClaim[]> {
  const { live, dead } = await readClaims(repo, io);
  for (const abs of dead) {
    try {
      await io.rm(abs);
    } catch {
      /* sweep is best-effort */
    }
  }
  return live;
}
