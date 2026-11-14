/*
<MODULE_CONTRACT>
<purpose>RFC-1536 (Q-2): shared governance-id allocation. A session
worktree's rfc.create/adr.create snapshot lags develop — a parallel session
can land the same id first. The shared reservation surface at
&lt;common-git-dir&gt;/forge/rfc-reservations.yaml is visible to every
checkout of the clone, so the next id is max(primary scan, worktree scan,
develop tip, reservations) + 1 and the claim is appended before the draft
file is written.</purpose>
<non-goals>
  <item>No cross-clone uniqueness — the reservation surface lives in the common git dir; sessions on different clones still collide (bounded consequence, RFC-1536 failure modes).</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The reservation file is shared local state, never a tracked artifact — it lives under the common git dir next to forge/registry.yaml.</item>
  <item>Entries carry `kind` so the RFC and ADR namespaces share one file without sharing a number space (Q-2).</item>
  <item>An unwritable surface degrades to the pre-RFC level: allocation falls back to max(scans)+1 with a warning — draft creation never hard-fails on the reservation layer.</item>
  <item>A reservation whose draft never lands stays a harmless gap; flow.integrate prunes only its own session's entries.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1536: shared governance-id allocation surface (Q-2: RFC + ADR kinds)</item>
  <item>RFC-1536: owning-checkout routing, FLOW-OPEN-01 dirty-primary warning, shared governance-id allocation (RFC+ADR)</item>
  <item>RFC-1536: type forge flow and rfc io against forge's own WorkspaceIO

The standalone forge extract has no @warpgogol/werkstatt-shared; the type-only import failed extract-verify (FLOW-CUT-13) for the 9.4.0 cut.</item>
  <item>RFC-1590: store append-only shared ledgers as one file per record</item>
</CHANGE_SUMMARY>
*/

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { WorkspaceIO } from "../../src/types.ts";

import { git, listLocalBranches, topLevel } from "../flow/git.ts";
import { withFlowLock } from "../flow/locks.ts";
import { commonGitDir } from "../flow/registry.ts";
import { primaryWorktree } from "../flow/worktree-path.ts";
import { LEGACY_FRICTION_FILE } from "../friction/store.ts";

export type GovernanceKind = "rfc" | "adr" | "friction";

export interface GovernanceIdAllocation {
  id: number;
  /** Which surface yielded the winning maximum. */
  source: "primary" | "develop" | "reservation" | "worktree";
  /** Non-empty when the reservation append failed and the run degraded. */
  warnings: string[];
}

export interface ReservationEntry {
  kind: GovernanceKind;
  id: number;
  /** Branch name when reserved inside a session worktree, else cwd's branch. */
  session: string | null;
  at: string;
}

const RESERVATIONS_RELATIVE = "forge/rfc-reservations.yaml";
const RESERVATIONS_LOCK_RELATIVE = "forge/rfc-reservations.lock";

const KIND_DIR: Record<GovernanceKind, string> = {
  rfc: "docs/rfcs",
  adr: "docs/adrs",
  // RFC-1590: friction records are per-record files under docs/frictions/.
  friction: "docs/frictions",
};

const KIND_ID_PATTERN: Record<GovernanceKind, RegExp> = {
  rfc: /^rfc-(\d{4})/,
  adr: /^adr-(\d{4})/,
  friction: /^F-(\d{4})/,
};

function idPattern(kind: GovernanceKind): RegExp {
  return KIND_ID_PATTERN[kind];
}

/** RFC-1590: the unmigrated single-file registry still bounds the id
 * space — friction's next id must clear both the directory and the
 * legacy file. null for kinds without a legacy surface. */
const KIND_LEGACY_FILE: Partial<Record<GovernanceKind, string>> = {
  friction: LEGACY_FRICTION_FILE,
};

async function legacyFileMax(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  let max = 0;
  for (const m of text.matchAll(/^\s*-?\s*id:\s*F-(\d{4})/gm)) {
    max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}

/** Highest legacy-file id committed on the develop tip — `git show`
 * since the file lives in history, not the working copy. */
async function legacyFileMaxOnDevelop(
  cwd: string,
  kind: GovernanceKind,
  io: WorkspaceIO,
): Promise<number> {
  const rel = KIND_LEGACY_FILE[kind];
  if (rel === undefined) return 0;
  const r = await git(cwd, io, ["show", `develop:${rel}`]);
  if (r.exitCode !== 0) return 0;
  let max = 0;
  for (const m of r.stdout.matchAll(/^\s*-?\s*id:\s*F-(\d{4})/gm)) {
    max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}

async function scanDirMax(dir: string, pattern: RegExp, io: WorkspaceIO): Promise<number> {
  if (!(await io.exists(dir))) return 0;
  let max = 0;
  for (const file of await io.readdir(dir)) {
    const match = file.name.match(pattern);
    if (match) max = Math.max(max, parseInt(match[1]!, 10));
  }
  return max;
}

/** Highest id of `kind` present on the develop tip — committed state even
 * when the primary working copy is stale. 0 when develop is absent. */
async function scanDevelopMax(cwd: string, kind: GovernanceKind, io: WorkspaceIO): Promise<number> {
  if (!(await listLocalBranches(cwd, io)).includes("develop")) return 0;
  const r = await git(cwd, io, ["ls-tree", "--name-only", "develop", "--", KIND_DIR[kind]]);
  if (r.exitCode !== 0) return 0;
  const pattern = idPattern(kind);
  let max = 0;
  for (const line of r.stdout.split("\n")) {
    const match = line.trim().match(pattern);
    if (match) max = Math.max(max, parseInt(match[1]!, 10));
  }
  return max;
}

export async function readReservations(commonGitDir: string): Promise<ReservationEntry[]> {
  const file = join(commonGitDir, RESERVATIONS_RELATIVE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const parsed = yamlParse(raw) as { reservations?: ReservationEntry[] } | null;
  return Array.isArray(parsed?.reservations) ? parsed.reservations : [];
}

/**
 * Append a reservation under a lock, pruning entries whose id already landed
 * in `landedIds` (consumed — the draft is on disk/on develop). A lost-prune
 * race is harmless: stale entries only raise the next id, never collide.
 */
export async function appendReservation(
  io: WorkspaceIO,
  cwd: string,
  entry: Omit<ReservationEntry, "at">,
  landedIds: ReadonlySet<number>,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const common = await commonGitDir(io, cwd);
    const file = join(common, RESERVATIONS_RELATIVE);
    const lock = join(common, RESERVATIONS_LOCK_RELATIVE);
    // The lock file lives inside forge/ — create it before open("wx") or a
    // fresh repo fails the reservation with ENOENT (F-0269).
    await mkdir(join(common, "forge"), { recursive: true });
    await withFlowLock(
      lock,
      { waitMs: 5_000, staleMs: 30_000 },
      async () => {
        const existing = await readReservations(common);
        const kept = existing.filter((e) => !(e.kind === entry.kind && landedIds.has(e.id)));
        kept.push({ ...entry, at: new Date().toISOString() });
        await writeFile(file, yamlStringify({ reservations: kept }), "utf8");
      },
      io,
    );
  } catch (error) {
    warnings.push(`reservation skipped — ${(error as Error).message}`);
  }
  return { warnings };
}

/**
 * Allocate the next governance id against every surface a session can see:
 * the primary checkout's docs dir, `develop`'s committed tree, the shared
 * reservation file, and the caller's own worktree scan (`worktreeMax` — the
 * caller already holds the claim-seeded local maximum).
 */
export async function allocateNextGovernanceId(
  io: WorkspaceIO,
  cwd: string,
  kind: GovernanceKind,
  worktreeMax: number,
): Promise<GovernanceIdAllocation> {
  const warnings: string[] = [];
  let primaryMax = 0;
  let reservations: ReservationEntry[] = [];
  let developMax = 0;
  try {
    const repoRoot = await topLevel(cwd, io);
    const root = repoRoot ?? cwd;
    const primary = await primaryWorktree(io, root);
    primaryMax = await scanDirMax(join(primary, KIND_DIR[kind]), idPattern(kind), io);
    const legacyRel = KIND_LEGACY_FILE[kind];
    if (legacyRel !== undefined) {
      primaryMax = Math.max(primaryMax, await legacyFileMax(join(primary, legacyRel)));
    }
    developMax = Math.max(
      await scanDevelopMax(root, kind, io),
      await legacyFileMaxOnDevelop(root, kind, io),
    );
    const common = await commonGitDir(io, root);
    reservations = await readReservations(common);
  } catch (error) {
    warnings.push(
      `shared surfaces unreadable — falling back to worktree scan: ${(error as Error).message}`,
    );
  }

  const reservationMax = reservations
    .filter((e) => e.kind === kind)
    .reduce((max, e) => Math.max(max, e.id), 0);

  const candidates: Array<[number, GovernanceIdAllocation["source"]]> = [
    [primaryMax, "primary"],
    [developMax, "develop"],
    [reservationMax, "reservation"],
    [worktreeMax, "worktree"],
  ];
  const [maxId, source] = candidates.reduce((a, b) => (b[0] > a[0] ? b : a));
  return { id: maxId + 1, source, warnings };
}

/** RFC-1590: allocate AND reserve under one lock — the reservation write and
 * the id choice share the lock section so two concurrent callers can never
 * pick the same id before either records its claim. Used by `friction.add`
 * (AC-2); `rfc.create`/`adr.create` keep the two-step form because their
 * writes happen immediately after allocation inside the same session lock. */
export async function reserveNextGovernanceId(
  io: WorkspaceIO,
  cwd: string,
  kind: GovernanceKind,
  worktreeMax: number,
  sessionBranch: string,
): Promise<GovernanceIdAllocation> {
  let allocation: GovernanceIdAllocation = {
    id: worktreeMax + 1,
    source: "worktree",
    warnings: [],
  };
  try {
    const common = await commonGitDir(io, cwd);
    const file = join(common, RESERVATIONS_RELATIVE);
    const lock = join(common, RESERVATIONS_LOCK_RELATIVE);
    // Same fresh-repo fix as appendReservation — the lock open needs forge/.
    await mkdir(join(common, "forge"), { recursive: true });
    await withFlowLock(
      lock,
      { waitMs: 5_000, staleMs: 30_000 },
      async () => {
        const warnings: string[] = [];
        let primaryMax = 0;
        let developMax = 0;
        try {
          const repoRoot = await topLevel(cwd, io);
          const root = repoRoot ?? cwd;
          const primary = await primaryWorktree(io, root);
          primaryMax = await scanDirMax(join(primary, KIND_DIR[kind]), idPattern(kind), io);
          const legacyRel = KIND_LEGACY_FILE[kind];
          if (legacyRel !== undefined) {
            primaryMax = Math.max(primaryMax, await legacyFileMax(join(primary, legacyRel)));
          }
          developMax = Math.max(
            await scanDevelopMax(root, kind, io),
            await legacyFileMaxOnDevelop(root, kind, io),
          );
        } catch (error) {
          warnings.push(
            `shared surfaces unreadable — falling back to worktree scan: ${(error as Error).message}`,
          );
        }
        const reservations = await readReservations(common);
        // Prune entries already consumed by a landed record — a stale entry
        // only raises the next id (harmless), a consumed one does too but
        // is removable once its id is on a shared surface.
        const landedFloor = Math.max(primaryMax, developMax);
        const kept = reservations.filter((e) => !(e.kind === kind && e.id <= landedFloor));
        const reservationMax = kept
          .filter((e) => e.kind === kind)
          .reduce((max, e) => Math.max(max, e.id), 0);
        const candidates: Array<[number, GovernanceIdAllocation["source"]]> = [
          [primaryMax, "primary"],
          [developMax, "develop"],
          [reservationMax, "reservation"],
          [worktreeMax, "worktree"],
        ];
        const [maxId, source] = candidates.reduce((a, b) => (b[0] > a[0] ? b : a));
        allocation = { id: maxId + 1, source, warnings };
        kept.push({
          kind,
          id: allocation.id,
          session: sessionBranch,
          at: new Date().toISOString(),
        });
        await mkdir(join(common, "forge"), { recursive: true });
        await writeFile(file, yamlStringify({ reservations: kept }), "utf8");
      },
      io,
    );
  } catch (error) {
    allocation.warnings.push(
      `reservation store unavailable — unreserved allocation: ${(error as Error).message}`,
    );
  }
  return allocation;
}

export async function allocateNextRfcId(
  io: WorkspaceIO,
  workspaceRoot: string,
  worktreeMax: number,
): Promise<GovernanceIdAllocation> {
  return allocateNextGovernanceId(io, workspaceRoot, "rfc", worktreeMax);
}

export async function allocateNextAdrId(
  io: WorkspaceIO,
  workspaceRoot: string,
  worktreeMax: number,
): Promise<GovernanceIdAllocation> {
  return allocateNextGovernanceId(io, workspaceRoot, "adr", worktreeMax);
}

/** Prune a session's own reservations — flow.integrate calls this once its
 * session branch landed; other sessions' entries are untouched. */
export async function pruneReservationsForSession(
  io: WorkspaceIO,
  cwd: string,
  sessionBranch: string,
): Promise<void> {
  try {
    const common = await commonGitDir(io, cwd);
    const file = join(common, RESERVATIONS_RELATIVE);
    const lock = join(common, RESERVATIONS_LOCK_RELATIVE);
    await withFlowLock(
      lock,
      { waitMs: 5_000, staleMs: 30_000 },
      async () => {
        const kept = (await readReservations(common)).filter((e) => e.session !== sessionBranch);
        await writeFile(file, yamlStringify({ reservations: kept }), "utf8");
      },
      io,
    );
  } catch {
    // Prune failure leaves harmless stale entries — never block integrate.
  }
}
