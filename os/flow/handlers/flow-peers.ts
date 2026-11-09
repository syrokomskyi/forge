/*
<MODULE_CONTRACT>
<purpose>flow.peers — the read-only live resource map (RFC-1543). Reports the
integrate.lock holder, live op-claims grouped by checkout, open missions per
worktree, and registered in-flight branches so an operator (or a second
agent session) can see who owns a shared checkout before flow.integrate
waits or refuses on it.</purpose>
<non-goals>
  <item>No mutation authority — peers observes; it never breaks locks, releases claims, or closes missions.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1543: flow.peers — forge/peers@1 report over lock holder, live claims, open missions, in-flight branches</item>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
</CHANGE_SUMMARY>
*/

import { join } from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveIo } from "../../../src/utils/io.ts";
import { openMissionsIn } from "../../mission/open-missions.ts";
import { commonGitDir, INTEGRATE_LOCK_RELATIVE_PATH, readRegistry } from "../registry.ts";
import { requireGit, topLevel } from "../git.ts";
import { describeHeldLock } from "../locks.ts";
import { isClaimLive, liveClaimsReadOnly, type OpClaim } from "../ops-registry.ts";

export const PEERS_SCHEMA = "forge/peers@1";

interface LockHolder {
  pid: number;
  host?: string;
  at?: string;
  bootId?: string;
}

export interface PeersReport {
  schema: typeof PEERS_SCHEMA;
  integrateLock: (LockHolder & { disposition: "live" | "dead-holder" | "stale" }) | null;
  claimsByCheckout: { workspaceRoot: string; claims: OpClaim[] }[];
  openMissions: string[];
  branchesInFlight: string[];
}

/** Read + liveness-check the integrate.lock holder — shared with ops sweeps. */
async function integrateLockHolder(
  io: ReturnType<typeof resolveIo>,
  common: string,
): Promise<PeersReport["integrateLock"]> {
  let parsed: LockHolder | null = null;
  try {
    const raw = JSON.parse(await io.readFile(join(common, INTEGRATE_LOCK_RELATIVE_PATH))) as Record<
      string,
      unknown
    >;
    if (typeof raw["pid"] === "number") {
      parsed = {
        pid: raw["pid"],
        host: typeof raw["host"] === "string" ? raw["host"] : undefined,
        at: typeof raw["at"] === "string" ? raw["at"] : undefined,
        bootId: typeof raw["bootId"] === "string" ? raw["bootId"] : undefined,
      };
    }
  } catch {
    return null;
  }
  if (parsed === null) return null;
  const d = describeHeldLock(
    { pid: parsed.pid, host: parsed.host, at: parsed.at ?? "", bootId: parsed.bootId },
    10 * 60_000,
  );
  return { ...parsed, disposition: d.disposition };
}

export async function runFlowPeers(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<PeersReport>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const io = resolveIo(context.io);
  await requireGit(io);

  const repoRoot = await topLevel(workspaceRoot, io);
  if (repoRoot === null) {
    throw new Error("flow.peers must run inside a git repository");
  }

  const common = await commonGitDir(io, repoRoot);
  const [lock, claims, openMissions, registry] = await Promise.all([
    integrateLockHolder(io, common),
    liveClaimsReadOnly(repoRoot, io),
    openMissionsIn(repoRoot, io),
    readRegistry(io, repoRoot).catch(() => null),
  ]);

  const byRoot = new Map<string, OpClaim[]>();
  for (const c of claims.filter((c) => isClaimLive(c))) {
    byRoot.set(c.workspaceRoot, [...(byRoot.get(c.workspaceRoot) ?? []), c]);
  }

  const report: PeersReport = {
    schema: PEERS_SCHEMA,
    integrateLock: lock,
    claimsByCheckout: [...byRoot.entries()].map(([root, list]) => ({
      workspaceRoot: root,
      claims: list,
    })),
    openMissions,
    branchesInFlight: (registry?.branches ?? []).map((b) => b.name),
  };

  if (outputFormat === "pretty") {
    logger.section("flow.peers");
    logger.info(
      lock === null
        ? "  integrate.lock: free"
        : `  integrate.lock: pid ${lock.pid} on ${lock.host ?? "?"} since ${lock.at ?? "?"} (${lock.disposition})`,
    );
    for (const g of report.claimsByCheckout) {
      for (const c of g.claims) {
        logger.info(
          `  claim ${c.opId}: ${c.command} (pid ${c.pid}, started ${c.startedAt}) on ${g.workspaceRoot} — ${c.paths.length} path(s)`,
        );
      }
    }
    if (report.openMissions.length > 0) {
      logger.info(`  open missions: ${report.openMissions.join(", ")}`);
    }
    if (report.branchesInFlight.length > 0) {
      logger.info(`  branches in flight: ${report.branchesInFlight.join(", ")}`);
    }
  }

  return {
    data: report,
    exitCode: 0,
    summary: `[flow.peers] ${lock === null ? "lock free" : `lock ${lock.disposition}`}, ${claims.length} live claim(s), ${report.openMissions.length} open mission(s)`,
  };
}
