/*
<MODULE_CONTRACT>
<purpose>flow.integrate preflight (RFC-1528) — a bounded, deterministic check list that
runs between the dirty-tree checks and the integration-gate spawn, refusing in
seconds what the gate would catch minutes later. Ordered: (1) worktree dirty +
lockfile-diff classification, (2) primary tracked dirt + classification,
(3) ecosystem.manifest.validate, (4) rfc.validate --id per changed RFC file,
(5) friction.validate. Each check runs only when resolvable (invoke port +
registry entry) — absence degrades with a note, never blocks. The list is
closed by the RFC: adding a check requires an amendment.</purpose>
<non-goals>
  <item>No auto-fix, no auto-commit — the lockfile classifier only labels the importer-prune-only shape with a remedy hint; a dirty pnpm-lock.yaml still refuses.</item>
  <item>No builds, no test suites — sub-minute deterministic validators only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
  <item>RFC-1544: attribute mission lockfile churn to owning checkout and auto-resolve foreign importer diffs (RFC-1544)</item>
  <item>ADR-0130: induced-change lockfile classifiers — BFS reachability for optional-flag removals, collapse pairs, induced packages/snapshots additions</item>
  <item>ADR-0129: F-0186/F-0187 — FLOW-INT-03 names paths + three-way remedy, FLOW-OPEN-01 same hint, forge CLI kernel-command hint</item>
  <item>RFC-0000: skip rfc-0000 template in integrate preflight id extraction; regen ecosystem manifest; file F-0207</item>
  <history>RFC-1528, RFC-1531, RFC-1537, RFC-1538, RFC-1545, RFC-1546</history>
</CHANGE_SUMMARY>
*/

import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import type {
  CommandRegistry,
  ForgeFlagValue,
  ForgeInvokeCommand,
  ForgeRegisteredCommandInfo,
  WorkspaceIO,
} from "../../src/types.ts";
import { loadLiveCommandInventory } from "../../src/utils/command-inventory.ts";
import { isGeneratedContent, isGeneratedPathName, REGEN_FLAGS } from "../core/archive-regen.ts";
import { openMissionsIn } from "../mission/open-missions.ts";
import {
  classifyDirtyPath,
  FOREIGN_PRIMARY_DIRT_HINT,
  summarizeClasses,
  type ClassifiedDirtyEntry,
  type DirtyClass,
} from "./dirty-classify.ts";
import { currentBranch, git, statusTracked, worktreeList } from "./git.ts";
import { canonicalRepoDir } from "../../src/utils/repo-path.ts";
import { claimCoversPath, liveClaims, type OpClaim } from "./ops-registry.ts";

export type LockfileClassification = "importer-prune-only" | "other";

/**
 * Strict match for the pnpm-prune shape: ONLY removed lines, every one either
 * a `missions/<id>/workpiece:` importer key or a deeper-indented member of
 * such a key's block. Returns the sorted pruned mission ids on match, null
 * otherwise — any added line, any other removed line, or a diff with no
 * removals is ambiguous and stays an ordinary refusal.
 */
export function classifyLockfilePruneIds(diffText: string): string[] | null {
  const ids = new Set<string>();
  let sawImporterKey = false;
  let openBlockIndent: number | null = null;
  for (const raw of diffText.split("\n")) {
    if (
      raw === "" ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@")
    ) {
      if (raw.startsWith("@@")) openBlockIndent = null;
      continue;
    }
    if (raw.startsWith("+")) return null;
    const line = raw.slice(1);
    if (raw[0] === " ") {
      const indent = line.length - line.trimStart().length;
      if (openBlockIndent !== null && line.trim().length > 0 && indent <= openBlockIndent) {
        openBlockIndent = null;
      }
      continue;
    }
    if (raw[0] !== "-") continue;
    if (line.trim().length === 0) {
      // A blank removed line only tolerates inside an open importer block.
      if (openBlockIndent === null) return null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const key = /^\s*missions\/([^\s/]+)\/workpiece:\s*$/.exec(line);
    if (key) {
      sawImporterKey = true;
      ids.add(key[1]);
      openBlockIndent = indent;
      continue;
    }
    if (openBlockIndent !== null && indent > openBlockIndent) continue;
    return null;
  }
  return sawImporterKey ? [...ids].sort() : null;
}

export function classifyLockfileDiff(diffText: string): LockfileClassification {
  return classifyLockfilePruneIds(diffText) !== null ? "importer-prune-only" : "other";
}

/**
 * Mirror of the prune shape for materialization (RFC-1537): ONLY added lines,
 * every one either a `missions/<id>/workpiece:` importer key or a deeper-
 * indented member of such a block. Returns the sorted mission ids on match,
 * null otherwise — any removal or foreign addition is ambiguous.
 */
export function classifyLockfileMaterialize(diffText: string): string[] | null {
  const ids = new Set<string>();
  let sawImporterKey = false;
  let openBlockIndent: number | null = null;
  for (const raw of diffText.split("\n")) {
    if (
      raw === "" ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@")
    ) {
      if (raw.startsWith("@@")) openBlockIndent = null;
      continue;
    }
    if (raw.startsWith("-")) return null;
    const line = raw.slice(1);
    if (raw[0] === " ") {
      const indent = line.length - line.trimStart().length;
      if (openBlockIndent !== null && line.trim().length > 0 && indent <= openBlockIndent) {
        openBlockIndent = null;
      }
      continue;
    }
    if (raw[0] !== "+") continue;
    if (line.trim().length === 0) {
      // A blank added line only tolerates inside an open importer block.
      if (openBlockIndent === null) return null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const key = /^\s*missions\/([^\s/]+)\/workpiece:\s*$/.exec(line);
    if (key) {
      sawImporterKey = true;
      ids.add(key[1]);
      openBlockIndent = indent;
      continue;
    }
    if (openBlockIndent !== null && indent > openBlockIndent) continue;
    return null;
  }
  return sawImporterKey ? [...ids].sort() : null;
}

// ---------------------------------------------------------------------------
// ADR-0130 (F-0201): induced-change lockfile shapes
//
// A `pnpm install` against a lockfile whose `importers:` list includes open
// mission workpieces produces diffs that are never pure block additions or
// removals — the dependency-graph write also adds/drops `optional: true`
// flags, collapses `key:\n  optional: true` pairs to `key: {}`, and adds or
// removes `packages:`/`snapshots:` members. The strict one-shape classifiers
// above see the extra hunks and degrade to `work`, which is the ping-pong the
// ADR stops. These extended classifiers accept the strict shape first and
// then the induced shape, bounded by where each hunk anchors in the HEAD
// lockfile.
// ---------------------------------------------------------------------------

const DIFF_HEADER = /^(diff |index |--- |\+\+\+ |@@ )/;
const TOP_LEVEL_KEY = /^(\S[^:]*):\s*$/;
const IMPORTER_KEY = /^\s*missions\/([^\s/]+)\/workpiece:\s*$/;
const OPTIONAL_TRUE = /^\s*optional: true\s*$/;

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  oldLine: number; // anchor position in the HEAD file (for `add`: line after which it inserts)
}

/** Parse `git diff` output into positioned lines (single-file diffs only). */
function parseDiffLines(diffText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldCursor = 0;
  for (const raw of diffText.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldCursor = Number(hunk[1]);
      lines.push({ kind: "hunk", text: raw, oldLine: oldCursor });
      continue;
    }
    if (DIFF_HEADER.test(raw) || raw === "") continue;
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldLine: oldCursor });
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldLine: oldCursor });
      oldCursor += 1;
      continue;
    }
    lines.push({ kind: "ctx", text: raw.slice(1), oldLine: oldCursor });
    oldCursor += 1;
  }
  return lines;
}

/** Top-level (`key:`) section containing old-file line `n` (1-based). */
function topLevelSectionAt(headLines: string[], n: number): string | null {
  let section: string | null = null;
  for (let i = 0; i < Math.min(n, headLines.length); i++) {
    const m = TOP_LEVEL_KEY.exec(headLines[i]);
    if (m) section = m[1];
  }
  return section;
}

/** Second-level `key:` (one-indent) enclosing old-file line `n` inside `section`. */
function secondLevelKeyAt(headLines: string[], n: number, section: string): string | null {
  let inSection = false;
  let key: string | null = null;
  for (let i = 0; i < Math.min(n, headLines.length); i++) {
    const line = headLines[i];
    const top = TOP_LEVEL_KEY.exec(line);
    if (top) {
      inSection = top[1] === section;
      key = null;
      continue;
    }
    if (!inSection || line.trim() === "") continue;
    const m = /^ {2}('?[^:]*'?):\s*(?:\{\})?\s*$/.exec(line);
    if (m) key = m[1].replace(/^'|'$/g, "");
  }
  return key;
}

/**
 * Snapshot keys reachable from `missionIds` in the working lockfile — BFS
 * from each `missions/<id>/workpiece` importer through `dependencies`,
 * `devDependencies` and `optionalDependencies` version specifiers, then
 * through each reached snapshot's own dependency maps. Specifiers that are
 * not registry resolutions (`link:`, `workspace:`, `file:`) have no snapshot
 * entry and are ignored.
 */
export function reachableSnapshotKeys(lockText: string, missionIds: string[]): Set<string> {
  const reachable = new Set<string>();
  let parsed: unknown;
  try {
    parsed = parseYaml(lockText);
  } catch {
    return reachable;
  }
  const root = parsed as Record<string, unknown> | null;
  const importers = (root?.importers ?? {}) as Record<string, unknown>;
  const snapshots = (root?.snapshots ?? {}) as Record<string, Record<string, unknown>>;
  const depMaps = (entry: Record<string, unknown>): string[] => {
    const out: string[] = [];
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = entry[field] as Record<string, unknown> | undefined;
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        const version =
          typeof spec === "string" ? spec : ((spec as Record<string, unknown>)?.version as string);
        if (typeof version !== "string") continue;
        if (/^(link|workspace|file):/.test(version)) continue;
        // pnpm strips the name for plain resolutions inside importers
        // (version only) but snapshot keys carry `name@version`.
        out.push(version.startsWith(`${name}@`) ? version : `${name}@${version}`);
      }
    }
    return out;
  };
  const queue: string[] = [];
  for (const id of missionIds) {
    const entry = importers[`missions/${id}/workpiece`] as Record<string, unknown> | undefined;
    if (entry) queue.push(...depMaps(entry));
  }
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    const snap = snapshots[key];
    if (snap) queue.push(...depMaps(snap));
  }
  return reachable;
}

/**
 * ADR-0130 criterion (b)+(c): materialize shape extended with induced
 * changes. Removed lines must be `optional: true` on snapshots reachable
 * from the added mission importers, or `key:` lines paired with an added
 * `key: {}` collapse. Added lines outside mission importer blocks must
 * anchor under `packages:` or `snapshots:` in the HEAD file.
 */
export function classifyLockfileMaterializeExtended(
  diffText: string,
  headText: string,
  workText: string,
): string[] | null {
  const strict = classifyLockfileMaterialize(diffText);
  if (strict !== null) return strict;
  const headLines = headText.split("\n");
  const lines = parseDiffLines(diffText);
  const missionIds = new Set<string>();
  const collapsedKeys = new Set<string>();
  const optionalRemovedOn = new Set<string>();
  let importerBlockIndent: number | null = null;
  let sawDiff = false;
  for (const line of lines) {
    if (line.kind === "hunk") {
      importerBlockIndent = null;
      continue;
    }
    if (line.kind === "ctx") {
      const indent = line.text.length - line.text.trimStart().length;
      if (
        line.text.trim().length > 0 &&
        importerBlockIndent !== null &&
        indent <= importerBlockIndent
      ) {
        importerBlockIndent = null;
      }
      continue;
    }
    sawDiff = true;
    if (line.kind === "add") {
      const text = line.text;
      const indent = text.length - text.trimStart().length;
      const key = IMPORTER_KEY.exec(text);
      if (key) {
        missionIds.add(key[1]);
        importerBlockIndent = indent;
        continue;
      }
      if (importerBlockIndent !== null && (indent > importerBlockIndent || text.trim() === "")) {
        continue; // member of an open importer block
      }
      if (indent <= (importerBlockIndent ?? indent)) importerBlockIndent = null;
      // Non-importer additions must anchor inside the dependency-graph
      // sections — the induced write never touches anything else.
      const section = topLevelSectionAt(headLines, line.oldLine);
      if (section === "packages" || section === "snapshots") continue;
      return null;
    }
    // removed line
    const text = line.text;
    if (OPTIONAL_TRUE.test(text)) {
      const owner = secondLevelKeyAt(headLines, line.oldLine, "snapshots");
      if (owner === null) return null;
      optionalRemovedOn.add(owner);
      continue;
    }
    const removedKey = /^(\s*'?[^:]*'?):\s*$/.exec(text);
    if (removedKey) {
      // allowed only as the `key:` → `key: {}` collapse — an added
      // `key: {}` must appear somewhere in the diff.
      collapsedKeys.add(removedKey[1].trim());
      const owner = removedKey[1].trim().replace(/^'|'$/g, "");
      const section = topLevelSectionAt(headLines, line.oldLine);
      if (section !== "snapshots") return null;
      optionalRemovedOn.add(owner);
      continue;
    }
    return null;
  }
  if (!sawDiff || missionIds.size === 0) return null;
  // every removed `key:` must be matched by an added `key: {}` — an
  // unmatched one is a real snapshot removal, not a collapse.
  for (const key of collapsedKeys) {
    const hasPair = lines.some((l) => l.kind === "add" && l.text.trim() === `${key}: {}`);
    if (!hasPair) return null;
  }
  const reachable = reachableSnapshotKeys(workText, [...missionIds]);
  for (const owner of optionalRemovedOn) {
    if (!reachable.has(owner)) return null;
  }
  return [...missionIds].sort();
}

/**
 * ADR-0130 prune direction: removed lines must still be importer-block
 * members (strict rule); added lines are tolerated only when they anchor
 * inside `packages:`/`snapshots:` — the inverse induced write (`optional:
 * true` re-additions, `transitivePeerDependencies`, snapshot entries).
 */
export function classifyLockfilePruneIdsExtended(
  diffText: string,
  headText: string,
): string[] | null {
  const strict = classifyLockfilePruneIds(diffText);
  if (strict !== null) return strict;
  const headLines = headText.split("\n");
  const lines = parseDiffLines(diffText);
  const ids = new Set<string>();
  const expandedKeys = new Set<string>();
  let sawImporterKey = false;
  let openBlockIndent: number | null = null;
  for (const line of lines) {
    if (line.kind === "hunk") {
      openBlockIndent = null;
      continue;
    }
    if (line.kind === "ctx") {
      const indent = line.text.length - line.text.trimStart().length;
      if (line.text.trim().length > 0 && openBlockIndent !== null && indent <= openBlockIndent) {
        openBlockIndent = null;
      }
      continue;
    }
    if (line.kind === "add") {
      const section = topLevelSectionAt(headLines, line.oldLine);
      if (section === "packages" || section === "snapshots") continue;
      return null;
    }
    const text = line.text;
    if (text.trim().length === 0) {
      if (openBlockIndent === null) return null;
      continue;
    }
    // inverse of the materialize collapse — the prune re-expands
    // `key: {}` into `key:` + `optional: true` children.
    const emptyEntry = /^(\s*'?[^:]*'?):\s*\{\}\s*$/.exec(text);
    if (emptyEntry) {
      const section = topLevelSectionAt(headLines, line.oldLine);
      if (section === "snapshots" || section === "packages") {
        expandedKeys.add(emptyEntry[1].trim());
        continue;
      }
      return null;
    }
    const indent = text.length - text.trimStart().length;
    const key = IMPORTER_KEY.exec(text);
    if (key) {
      sawImporterKey = true;
      ids.add(key[1]);
      openBlockIndent = indent;
      continue;
    }
    if (openBlockIndent !== null && indent > openBlockIndent) continue;
    return null;
  }
  if (!sawImporterKey) return null;
  // every removed `key: {}` must pair with an added `key:` — an unmatched
  // one is a real snapshot removal, not a re-expansion.
  for (const key of expandedKeys) {
    const hasPair = lines.some((l) => l.kind === "add" && l.text.trim() === `${key}:`);
    if (!hasPair) return null;
  }
  return [...ids].sort();
}

/** Classify the pnpm-lock.yaml diff of `repo` when the lockfile is dirty. */
async function classifyDirtyLockfile(
  repo: string,
  io: WorkspaceIO,
  dirtyEntries: string[],
  runGit: typeof git,
): Promise<LockfileClassification | null> {
  const lockfileDirty = dirtyEntries.some((entry) => entry.slice(3).trim() === "pnpm-lock.yaml");
  if (!lockfileDirty) return null;
  const diff = await runGit(repo, io, ["diff", "HEAD", "--", "pnpm-lock.yaml"]);
  return classifyLockfileDiff(diff.stdout);
}

// ── RFC-1537: regenerable dirt classifier ────────────────────────────────
// Q-4 (RFC-1531): the class enum is shared — dirty-classify.ts owns the
// closed vocabulary; this module only assigns its diff-aware members.

export type { DirtyClass } from "./dirty-classify.ts";

export interface ToleratedEntry {
  path: string;
  class: DirtyClass;
  /** RFC-1544: pruned mission ids for the lockfile importer classes. */
  missionIds?: string[];
}

/**
 * RFC-1544: referent state for one pruned `missions/<id>/workpiece` importer
 * — where the directory still exists and whether its mission is open. The
 * classifier stays pure: referents are injected by the caller.
 */
export interface ImporterReferent {
  missionId: string;
  /** `missions/<id>/workpiece` exists in the checkout being classified. */
  existsHere: boolean;
  /** Other registered worktrees where the directory exists. */
  existsInCheckout: string[];
  /** An open `missions/<id>/mission.yaml` exists in any registered checkout. */
  missionOpen: boolean;
}

/**
 * Default referent resolver — `git worktree list` for the checkout set and
 * `openMissionsIn` per checkout for mission state (the same enumeration
 * `flow.status` performs; never cwd-relative guesses).
 */
export async function resolveImporterReferents(
  repo: string,
  io: WorkspaceIO,
  missionIds: string[],
): Promise<ImporterReferent[]> {
  const worktrees = await worktreeList(repo, io);
  const here = canonicalRepoDir(repo);
  const others = worktrees.filter((w) => w.path !== here).map((w) => w.path);
  const openCache = new Map<string, Set<string>>();
  const openIn = async (dir: string): Promise<Set<string>> => {
    let set = openCache.get(dir);
    if (set === undefined) {
      try {
        set = new Set(await openMissionsIn(dir, io));
      } catch {
        set = new Set();
      }
      openCache.set(dir, set);
    }
    return set;
  };
  const out: ImporterReferent[] = [];
  for (const missionId of missionIds) {
    const rel = join("missions", missionId, "workpiece");
    const existsHere = await io.exists(join(repo, rel));
    const existsInCheckout: string[] = [];
    for (const dir of others) {
      if (await io.exists(join(dir, rel))) existsInCheckout.push(dir);
    }
    let missionOpen = (await openIn(repo)).has(missionId);
    for (const dir of others) {
      if (!missionOpen && (await openIn(dir)).has(missionId)) missionOpen = true;
    }
    out.push({ missionId, existsHere, existsInCheckout: existsInCheckout.sort(), missionOpen });
  }
  return out;
}

export interface DirtVerdict {
  tolerated: ToleratedEntry[];
  /** Porcelain lines that match no declared regenerable shape — still refuse. */
  unattributed: string[];
  /**
   * RFC-1543: unattributed paths covered by a LIVE op-claim — class
   * `in-flight-foreign`. They never block silently: the caller either waits
   * for the holder or refuses FLOW-INT-03 naming it. Resolved only for the
   * primary checkout — worktrees are single-owner.
   */
  foreignInFlight: { path: string; holder: OpClaim }[];
}

const TWIN_ROOT = ".agents/skills/";

/** Canonical candidates for a `.agents/skills/<dir>/<rel>` twin path. */
function twinCanonicalCandidates(dir: string, rel: string): string[] {
  const candidates = [
    `packages/forge/skills/${dir}/${rel}`,
    `packages/forge/skills/fo/${dir}/${rel}`,
    `packages/forge/skills/meta/${dir}/${rel}`,
    `packages/werkstatt-site/src/domain/skills/${dir}/${rel}`,
  ];
  if (dir === "shared-knowledge") {
    candidates.push(`packages/forge/skills/shared/knowledge/${rel}`);
  }
  return candidates;
}

async function fileBytesEqual(a: string, b: string, io: WorkspaceIO): Promise<boolean> {
  const [ba, bb] = await Promise.all([io.readFileBytes(a), io.readFileBytes(b)]);
  return ba.length === bb.length && ba.every((v, i) => v === bb[i]);
}

/** `.prettierignore` diff is twin-sync only when every change adds .agents/skills/ lines. */
function prettierignoreTwinOnly(diffText: string): boolean {
  let saw = false;
  for (const raw of diffText.split("\n")) {
    if (
      raw === "" ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@") ||
      raw.startsWith(" ")
    ) {
      continue;
    }
    if (raw.startsWith("-")) return false;
    if (raw.startsWith("+")) {
      if (!/^\+\s*\.agents\/skills\/[^\s]+\/?\s*$/.test(raw)) return false;
      saw = true;
    }
  }
  return saw;
}

/**
 * Partition porcelain lines into declared regenerable classes (tolerated —
 * journaled, never committed) and `unattributed` lines that still refuse.
 * The shapes are closed by RFC-1537: ambiguity always degrades to
 * unattributed, never to tolerance.
 */
export async function classifyDirt(
  repo: string,
  io: WorkspaceIO,
  entries: string[],
  deps: { runGit: typeof git } = { runGit: git },
  claims: OpClaim[] = [],
  resolveReferents?: (missionIds: string[]) => Promise<ImporterReferent[]>,
): Promise<DirtVerdict> {
  const tolerated: ToleratedEntry[] = [];
  const unattributed: string[] = [];
  const foreignInFlight: { path: string; holder: OpClaim }[] = [];
  const byPath = new Map<string, string[]>();
  for (const line of entries) {
    const p = line.slice(3).trim();
    byPath.set(p, [...(byPath.get(p) ?? []), line]);
  }

  let openMissions: Set<string> | null = null;
  const openMissionIds = async (): Promise<Set<string>> => {
    if (openMissions === null) {
      openMissions = new Set(await openMissionsIn(repo, io));
    }
    return openMissions;
  };

  outer: for (const [path, lines] of byPath) {
    if (path === "pnpm-lock.yaml") {
      const diff = await deps.runGit(repo, io, ["diff", "HEAD", "--", "pnpm-lock.yaml"]);
      // ADR-0130: the induced-change shapes need the HEAD and working
      // contents — fetched lazily, only when the strict shapes miss.
      let headLock: string | null = null;
      let workLock: string | null = null;
      const lockContents = async (): Promise<{ head: string; work: string } | null> => {
        if (headLock === null || workLock === null) {
          const head = await deps.runGit(repo, io, ["show", "HEAD:pnpm-lock.yaml"]);
          if (head.exitCode !== 0) return null;
          let work: string;
          try {
            work = await io.readFile(join(repo, "pnpm-lock.yaml"));
          } catch {
            return null; // reduced io — degrade to the strict-shape verdict
          }
          headLock = head.stdout;
          workLock = work;
        }
        return { head: headLock, work: workLock };
      };
      let pruneIds = classifyLockfilePruneIds(diff.stdout);
      if (pruneIds === null) {
        const contents = await lockContents();
        if (contents !== null) {
          pruneIds = classifyLockfilePruneIdsExtended(diff.stdout, contents.head);
        }
      }
      if (pruneIds !== null) {
        // RFC-1544: the pruned importer's referent decides the class — a
        // foreign checkout's open mission (foreign-open-mission, auto-
        // restored by flow.integrate), dead residue (importer-prune-stale,
        // accepted cleanup), or anything else (importer-prune, unchanged).
        // An unresolvable referent set (no exec/ io capability) degrades to
        // the inert importer-prune — "couldn't resolve" is not "resolved to
        // nothing".
        let referents: ImporterReferent[] | undefined;
        if (resolveReferents !== undefined) {
          try {
            referents = await resolveReferents(pruneIds);
          } catch {
            referents = undefined;
          }
        }
        if (
          referents !== undefined &&
          referents.every((r) => !r.existsHere && r.missionOpen && r.existsInCheckout.length > 0)
        ) {
          tolerated.push({ path, class: "foreign-open-mission", missionIds: pruneIds });
        } else if (
          referents !== undefined &&
          referents.every((r) => !r.existsHere && r.existsInCheckout.length === 0 && !r.missionOpen)
        ) {
          tolerated.push({ path, class: "importer-prune-stale", missionIds: pruneIds });
        } else {
          tolerated.push({ path, class: "importer-prune", missionIds: pruneIds });
        }
        continue;
      }
      let ids = classifyLockfileMaterialize(diff.stdout);
      if (ids === null) {
        const contents = await lockContents();
        if (contents !== null) {
          ids = classifyLockfileMaterializeExtended(diff.stdout, contents.head, contents.work);
        }
      }
      if (ids !== null) {
        const open = await openMissionIds();
        if (ids.every((id) => open.has(id))) {
          tolerated.push({ path, class: "importer-materialize" });
          continue;
        }
      }
      unattributed.push(...lines);
      continue;
    }
    if (path === ".prettierignore") {
      const diff = await deps.runGit(repo, io, ["diff", "HEAD", "--", ".prettierignore"]);
      if (prettierignoreTwinOnly(diff.stdout)) {
        tolerated.push({ path, class: "skill-twin-sync" });
        continue;
      }
      unattributed.push(...lines);
      continue;
    }
    if (path.startsWith(TWIN_ROOT) && path.length > TWIN_ROOT.length) {
      const rel = path.slice(TWIN_ROOT.length).replace(/\/$/, "");
      const dir = rel.split("/")[0];
      const fileRel = rel.slice(dir.length + 1);
      if (fileRel === "") {
        // `?? .agents/skills/<dir>/` — an untracked twin DIRECTORY. Fail
        // closed: every file inside must byte-match a canonical source or be
        // the .forge-managed marker beside one; a single stray stays dirty.
        const canonicalDir = async (): Promise<boolean> => {
          for (const c of twinCanonicalCandidates(dir, "SKILL.md")) {
            if (await io.exists(join(repo, dirname(c)))) return true;
          }
          return false;
        };
        const files = (await io.glob(`${TWIN_ROOT}${rel}/**`, { cwd: repo })).filter(
          (f) => !f.endsWith("/"),
        );
        let allTwins = files.length > 0 && (await canonicalDir());
        for (const f of allTwins ? files : []) {
          const frel = f.slice(`${TWIN_ROOT}${rel}/`.length);
          if (frel === ".forge-managed") continue;
          let matched = false;
          for (const c of twinCanonicalCandidates(dir, frel)) {
            const abs = join(repo, c);
            if ((await io.exists(abs)) && (await fileBytesEqual(join(repo, f), abs, io))) {
              matched = true;
              break;
            }
          }
          if (!matched) {
            allTwins = false;
            break;
          }
        }
        if (allTwins) tolerated.push({ path, class: "skill-twin-sync" });
        else unattributed.push(...lines);
        continue;
      }
      if (fileRel === ".forge-managed") {
        // Twin bookkeeping file — tolerated when the dir has any canonical
        // skill source; a free-floating marker is real dirt.
        let markerOk = false;
        for (const c of twinCanonicalCandidates(dir, "SKILL.md")) {
          if (await io.exists(join(repo, dirname(c)))) {
            markerOk = true;
            break;
          }
        }
        if (markerOk) tolerated.push({ path, class: "skill-twin-sync" });
        else unattributed.push(...lines);
        continue;
      }
      let matched = false;
      for (const c of twinCanonicalCandidates(dir, fileRel)) {
        const abs = join(repo, c);
        if ((await io.exists(abs)) && (await fileBytesEqual(join(repo, path), abs, io))) {
          matched = true;
          break;
        }
      }
      if (matched) tolerated.push({ path, class: "skill-twin-sync" });
      else unattributed.push(...lines);
      continue;
    }
    unattributed.push(...lines);
  }
  // RFC-1543 AC-3: unattributed paths covered by a live claim reclassify as
  // in-flight-foreign — every other unattributed path stays work-class.
  if (claims.length > 0) {
    const stillUnattributed: string[] = [];
    for (const line of unattributed) {
      const path = line.slice(3).trim();
      const holder = claims.find((c) => claimCoversPath(c, path));
      if (holder !== undefined) foreignInFlight.push({ path, holder });
      else stillUnattributed.push(line);
    }
    unattributed.length = 0;
    unattributed.push(...stillUnattributed);
  }
  return { tolerated, unattributed, foreignInFlight };
}

/**
 * RFC-1531 AC-6: classify EVERY dirty entry — tolerated-family classes come
 * from the diff-aware classifyDirt; the remaining entries get their
 * path-only class (disposable or work — importer/twin classes can only be
 * diff-assigned, so they never appear here). Used for FLOW-INT-01's
 * data.entries and by the remediation flags.
 */
export async function classifyDirtyEntries(
  repo: string,
  io: WorkspaceIO,
  entries: string[],
  deps: { runGit: typeof git } = { runGit: git },
): Promise<ClassifiedDirtyEntry[]> {
  const verdict = await classifyDirt(repo, io, entries, deps);
  const out: ClassifiedDirtyEntry[] = verdict.tolerated.map((t) => ({
    path: t.path,
    class: t.class,
  }));
  for (const f of verdict.foreignInFlight) {
    out.push({ path: f.path, class: "in-flight-foreign" });
  }
  for (const line of verdict.unattributed) {
    const path = line.slice(3).trim();
    out.push({ path, class: classifyDirtyPath(path) });
  }
  return out;
}

const LOCKFILE_PRUNE_HINT =
  " — its diff matches the vanished mission-importer prune shape; restore it " +
  "(`git checkout -- pnpm-lock.yaml` is blocked for agents: copy HEAD bytes " +
  "with `git show HEAD:pnpm-lock.yaml > pnpm-lock.yaml`) or commit the prune deliberately";

export interface PreflightRefuse {
  ruleId: string;
  message: string;
  fixHint: string;
  data?: Record<string, unknown>;
}

export interface PreflightSkip {
  check: string;
  reason: "no-invoke" | "unresolvable";
}

export interface IntegratePreflightResult {
  ok: boolean;
  /** Check names that ran, in order. */
  checked: string[];
  /** Checks skipped — invoke port absent, or command not in the inventory. */
  skipped: PreflightSkip[];
  /** RFC-1537: regenerable dirt tolerated on this run — journaled, never
   * committed or silently absorbed. */
  tolerated: ToleratedEntry[];
  refuse?: PreflightRefuse;
}

/**
 * The bounded preflight — first failure wins. `deps` seams exist for tests;
 * production passes the real git helpers.
 */
export async function runIntegratePreflight(
  opts: {
    primary: string;
    branchWorktree: string;
    branch: string;
    io: WorkspaceIO;
    /** Already-computed statusDirty() of the branch worktree. */
    worktreeDirty: { entries: string[]; toleratedState: string[] };
    invoke?: ForgeInvokeCommand;
    /**
     * RFC-1543 AC-4: seconds to wait for live foreign claim-holders before
     * FLOW-INT-03 refuses — default 600, 0 restores fail-fast.
     */
    waitForeignSeconds?: number;
    onProgress?: (line: string) => void;
    commandRegistry?: CommandRegistry;
    /** Test seam — overrides the live inventory union (registry + command manifest). */
    commands?: ForgeRegisteredCommandInfo[];
  },
  deps: {
    runGit: typeof git;
    runStatusTracked: typeof statusTracked;
    runCurrentBranch: typeof currentBranch;
  } = { runGit: git, runStatusTracked: statusTracked, runCurrentBranch: currentBranch },
): Promise<IntegratePreflightResult> {
  const checked: string[] = [];
  const skipped: PreflightSkip[] = [];
  const tolerated: ToleratedEntry[] = [];
  const { io } = opts;
  // D-001 union: werkstatt run supplies invoke but no commandRegistry — the
  // generated manifest (in the primary checkout) covers resolvability.
  const commands = opts.commands ?? loadLiveCommandInventory(opts.primary, opts.commandRegistry);
  const commandNames = new Set(commands.map((c) => c.name));
  const resolvable = (name: string) => opts.invoke !== undefined && commandNames.has(name);

  // (0) open mission in the integrating worktree — WT-GATE-01 semantics at
  // preflight price (RFC-1537): ahead of every validator arm and even the
  // dirty checks, since a live mission outranks a dirty tree. A scan failure
  // skips with a note — the downstream gate still enforces.
  try {
    const openMissions = await openMissionsIn(opts.branchWorktree, io);
    checked.push("open-mission");
    if (openMissions.length > 0) {
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "WT-GATE-01",
          message: `worktree has ${openMissions.length} open mission(s): ${openMissions.join(", ")}`,
          fixHint:
            "close or abort the mission(s) in the worktree before integrating or tearing down",
          data: { openMissions },
        },
      };
    }
  } catch {
    skipped.push({ check: "open-mission", reason: "unresolvable" });
  }

  // (1) worktree dirty — FLOW-INT-01 only on unattributed entries; declared
  // regenerable classes journal as tolerated (RFC-1537).
  checked.push("worktree-dirty");
  if (opts.worktreeDirty.entries.length > 0) {
    const verdict = await classifyDirt(
      opts.branchWorktree,
      io,
      opts.worktreeDirty.entries,
      {
        runGit: deps.runGit,
      },
      [],
      (ids) => resolveImporterReferents(opts.branchWorktree, io, ids),
    );
    tolerated.push(...verdict.tolerated);
    if (verdict.unattributed.length > 0) {
      const lockfile = await classifyDirtyLockfile(
        opts.branchWorktree,
        io,
        verdict.unattributed,
        deps.runGit,
      );
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "FLOW-INT-01",
          message:
            `worktree ${opts.branchWorktree} has ${verdict.unattributed.length} uncommitted change(s): ${verdict.unattributed.slice(0, 10).join(", ")}` +
            (verdict.tolerated.length > 0
              ? ` — tolerated regenerable state: ${verdict.tolerated.map((t) => `${t.path} (${t.class})`).join(", ")}`
              : "") +
            (opts.worktreeDirty.toleratedState.length > 0
              ? ` — tolerated forge-local state: ${opts.worktreeDirty.toleratedState.join(", ")}`
              : "") +
            (lockfile === "importer-prune-only" ? ` — pnpm-lock.yaml${LOCKFILE_PRUNE_HINT}` : ""),
          fixHint:
            "commit or revert the uncommitted changes inside the session worktree, or remediate with --auto-clean / --autocommit, then re-run",
          data: {
            // RFC-1531 AC-6: per-path classes so the remedy is read from
            // the diagnostic — disposable members may --auto-clean away,
            // work members must be committed or reverted (or --autocommit).
            entries: verdict.unattributed.map((line) => {
              const path = line.slice(3).trim();
              return { path, class: classifyDirtyPath(path) };
            }),
            classes: summarizeClasses(
              verdict.unattributed.map((line) => {
                const path = line.slice(3).trim();
                return { path, class: classifyDirtyPath(path) };
              }),
            ),
            toleratedState: opts.worktreeDirty.toleratedState,
            toleratedDirt: verdict.tolerated,
            ...(lockfile !== null ? { lockfileClassification: lockfile } : {}),
          },
        },
      };
    }
  }

  // (2) primary must sit clean on develop — early FLOW-INT-03, same
  // classification; the post-gate check stays (primary can dirty mid-gate).
  checked.push("primary-dirty");
  const primaryBranch = await deps.runCurrentBranch(opts.primary, io);
  // RFC-1543 AC-4: primary-side foreign claims get a bounded wait — the poll
  // re-reads both dirt and claims (≤30s cadence) until they clear or the
  // budget expires; unattributed work refuses instantly as before.
  const waitForeignMs = Math.max(0, (opts.waitForeignSeconds ?? 600) * 1000);
  const foreignDeadline = Date.now() + waitForeignMs;
  let primaryClean = false;
  for (;;) {
    const primaryDirty = await deps.runStatusTracked(opts.primary, io);
    if (primaryDirty.entries.length === 0) {
      primaryClean = true;
      break;
    }
    const verdict = await classifyDirt(
      opts.primary,
      io,
      primaryDirty.entries,
      { runGit: deps.runGit },
      await liveClaims(opts.primary, io),
      (ids) => resolveImporterReferents(opts.primary, io, ids),
    );
    tolerated.push(...verdict.tolerated);
    const foreignOnly =
      verdict.unattributed.length === 0 &&
      verdict.foreignInFlight.length > 0 &&
      primaryBranch === "develop";
    if (foreignOnly && Date.now() < foreignDeadline) {
      const holders = verdict.foreignInFlight.map(
        (f) =>
          `${f.holder.command} ${f.holder.opId} (pid ${f.holder.pid}, started ${f.holder.startedAt})`,
      );
      opts.onProgress?.(
        `primary held by foreign op(s): ${holders.join("; ")} — waiting up to ${Math.ceil((foreignDeadline - Date.now()) / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, Math.min(30_000, foreignDeadline - Date.now())));
      continue;
    }
    if (
      primaryBranch !== "develop" ||
      verdict.unattributed.length > 0 ||
      verdict.foreignInFlight.length > 0
    ) {
      const lockfile = await classifyDirtyLockfile(
        opts.primary,
        io,
        verdict.unattributed,
        deps.runGit,
      );
      const holderNote =
        verdict.foreignInFlight.length > 0
          ? ` — in-flight holder(s): ${verdict.foreignInFlight.map((f) => `${f.holder.command} ${f.holder.opId} (pid ${f.holder.pid})`).join("; ")}`
          : "";
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "FLOW-INT-03",
          message:
            (primaryBranch !== "develop"
              ? `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`
              : verdict.unattributed.length > 0
                ? // ADR-0129 (F-0186): name the paths — the remedy differs by
                  // whose work each one is.
                  `primary worktree has ${verdict.unattributed.length} uncommitted change(s): ${verdict.unattributed
                    .slice(0, 20)
                    .map((line) => line.slice(3).trim())
                    .join(", ")}` +
                  (verdict.unattributed.length > 20
                    ? ` (+${verdict.unattributed.length - 20} more)`
                    : "")
                : `primary worktree held by ${verdict.foreignInFlight.length} in-flight foreign op(s)`) +
            holderNote +
            (verdict.tolerated.length > 0
              ? ` — tolerated regenerable state: ${verdict.tolerated.map((t) => `${t.path} (${t.class})`).join(", ")}`
              : "") +
            (lockfile === "importer-prune-only" ? ` — pnpm-lock.yaml${LOCKFILE_PRUNE_HINT}` : ""),
          fixHint:
            primaryBranch !== "develop"
              ? "switch the primary to develop and commit or revert its tracked changes, then re-run — the branch stays rebased"
              : `${FOREIGN_PRIMARY_DIRT_HINT}, then re-run`,
          data: {
            unattributed: verdict.unattributed.map((line) => line.slice(3).trim()),
            entries: verdict.unattributed.map((line) => {
              const path = line.slice(3).trim();
              return { path, class: classifyDirtyPath(path) };
            }),
            foreignHolders: verdict.foreignInFlight.map((f) => ({
              path: f.path,
              opId: f.holder.opId,
              command: f.holder.command,
              pid: f.holder.pid,
              startedAt: f.holder.startedAt,
            })),
            toleratedDirt: verdict.tolerated,
            ...(lockfile !== null ? { lockfileClassification: lockfile } : {}),
          },
        },
      };
    }
    primaryClean = true;
    break;
  }
  if (!primaryClean && primaryBranch !== "develop") {
    return {
      ok: false,
      checked,
      skipped,
      tolerated,
      refuse: {
        ruleId: "FLOW-INT-03",
        message: `primary worktree is on ${primaryBranch ?? "detached HEAD"}, not develop`,
        fixHint:
          "switch the primary to develop and commit or revert its tracked changes, then re-run — the branch stays rebased",
      },
    };
  }

  // (3) ecosystem.manifest.validate — stale generated manifest is a
  // recoverable violation (RFC-1546): the failure is recorded and the
  // remaining checks still run. Only when the drift is the SOLE violation
  // does the owner command regenerate in place and the validator re-run —
  // a coexisting refusal below must skip the regeneration entirely.
  let manifestDrift: { summary?: string; exitCode?: number } | undefined;
  if (resolvable("ecosystem.manifest.validate")) {
    checked.push("ecosystem.manifest.validate");
    const result = await opts.invoke!("ecosystem.manifest.validate", {});
    if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
      manifestDrift = { summary: result.summary, exitCode: result.exitCode };
    }
  } else {
    skipped.push({
      check: "ecosystem.manifest.validate",
      reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
    });
  }

  // (4) rfc.validate --id per changed RFC file on develop...branch.
  // --diff-filter=d excludes deletions — an archive move's old path must not
  // produce a validate-id on a vanished file.
  const diff = await deps.runGit(opts.primary, io, [
    "diff",
    "--name-only",
    "--diff-filter=d",
    `develop...${opts.branch}`,
  ]);
  const changedRfcIds = [
    ...new Set(
      diff.stdout
        .split("\n")
        .map(
          (l) =>
            /^docs\/rfcs\/(?:archive\/(?:implemented|rejected|superseded)\/)?rfc-(\d+)-[^/]*\.md$/.exec(
              l.trim(),
            )?.[1],
        )
        // rfc-0000-template.md is corpus-excluded (listRfcFiles) — it is a
        // template, not a validateable RFC.
        .filter((m): m is string => m !== undefined && m !== "0000")
        .map((n) => `RFC-${n.padStart(4, "0")}`),
    ),
  ];
  if (changedRfcIds.length > 0) {
    if (resolvable("rfc.validate")) {
      for (const id of changedRfcIds) {
        checked.push(`rfc.validate:${id}`);
        const result = await opts.invoke!("rfc.validate", { id });
        if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
          return {
            ok: false,
            checked,
            skipped,
            tolerated,
            refuse: {
              ruleId: "FLOW-INT-13",
              message: `preflight: rfc.validate ${id} refused — ${result.summary ?? `exit ${result.exitCode}`}`,
              fixHint: "fix the RFC diagnostics, commit, then re-run flow.integrate",
              data: { command: "rfc.validate", id, summary: result.summary },
            },
          };
        }
      }
    } else {
      skipped.push({
        check: "rfc.validate",
        reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
      });
    }
  }

  // (5) friction.validate — a broken registry refuses early.
  if (resolvable("friction.validate")) {
    checked.push("friction.validate");
    const result = await opts.invoke!("friction.validate", {});
    if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "FLOW-INT-14",
          message: `preflight: friction.validate refused — ${result.summary ?? `exit ${result.exitCode}`}`,
          fixHint:
            "repair docs/frictions.yaml (e.g. a duplicate id), commit, then re-run flow.integrate",
          data: { command: "friction.validate", summary: result.summary },
        },
      };
    }
  } else {
    skipped.push({
      check: "friction.validate",
      reason: opts.invoke === undefined ? "no-invoke" : "unresolvable",
    });
  }

  // RFC-1546: every other check passed — the manifest drift is the sole
  // violation, so the owner command regenerates in place and the validator
  // re-runs. A coexisting violation already refused above without ever
  // reaching the regeneration.
  if (manifestDrift !== undefined) {
    if (resolvable("ecosystem.manifest.generate")) {
      const regen = await opts.invoke!(
        "ecosystem.manifest.generate",
        REGEN_FLAGS["ecosystem.manifest.generate"] ?? {},
      );
      if (regen.ok !== false && (regen.exitCode === undefined || regen.exitCode === 0)) {
        checked.push("ecosystem.manifest.generate", "ecosystem.manifest.validate");
        const result = await opts.invoke!("ecosystem.manifest.validate", {});
        if (result.ok !== false && (result.exitCode === undefined || result.exitCode === 0)) {
          manifestDrift = undefined;
        }
      }
    }
    if (manifestDrift !== undefined) {
      return {
        ok: false,
        checked,
        skipped,
        tolerated,
        refuse: {
          ruleId: "FLOW-INT-12",
          message: `preflight: ecosystem.manifest.validate refused — ${manifestDrift.summary ?? `exit ${manifestDrift.exitCode}`}`,
          fixHint:
            "regenerate the manifest via `pnpm exec werkstatt run ecosystem.manifest.generate`, commit, then re-run flow.integrate",
          data: { command: "ecosystem.manifest.validate", summary: manifestDrift.summary },
        },
      };
    }
  }

  return { ok: true, checked, skipped, tolerated };
}

// ── RFC-1538: generated-conflict classification ──────────────────────────

export interface ConflictOwner {
  path: string;
  command: string;
  flags: Record<string, ForgeFlagValue>;
}

export interface RebaseConflictVerdict {
  /** Generated paths with a discoverable owner command — auto-resolvable. */
  owners: ConflictOwner[];
  /** Non-generated paths, or generated paths with no owner → FLOW-INT-02. */
  nonGenerated: string[];
}

/** `.generated.` basenames whose owner command is fixed by convention. */
export const GENERATED_BASENAME_OWNERS: Record<string, string> = {
  "ecosystem.generated.yaml": "ecosystem.manifest.generate",
  "command-manifest.generated.yaml": "command.manifest.generate",
};

/**
 * Classify a rebase conflict set (RFC-1538): every path must classify
 * generated via isGeneratedPathName/isGeneratedContent (stage-2/3 content),
 * and every generated path must name an owner command — from its own
 * generated header (`command:`/`regenerateCommand:`/`ownerCommand:`), or the
 * `.generated.` basename registry. Anything else stays nonGenerated and the
 * integrate refuses FLOW-INT-02 exactly as before.
 */
export async function classifyRebaseConflicts(
  repo: string,
  io: WorkspaceIO,
  paths: string[],
  deps: { runGit: typeof git } = { runGit: git },
): Promise<RebaseConflictVerdict> {
  const owners: ConflictOwner[] = [];
  const nonGenerated: string[] = [];
  for (const p of paths) {
    let content = "";
    for (const stage of [":2:", ":3:"]) {
      const r = await deps.runGit(repo, io, ["show", `${stage}${p}`]);
      if (r.exitCode === 0 && r.stdout.length > 0) {
        content = r.stdout;
        break;
      }
    }
    const byName = isGeneratedPathName(p);
    const byContent = content !== "" && isGeneratedContent(content);
    if (!byName && !byContent) {
      nonGenerated.push(p);
      continue;
    }
    const header = /^(?:command|regenerateCommand|ownerCommand):\s*(\S.*?)\s*$/m.exec(
      content.split("\n").slice(0, 15).join("\n"),
    )?.[1];
    const line = header ?? GENERATED_BASENAME_OWNERS[basename(p)] ?? null;
    if (line === null) {
      nonGenerated.push(p);
      continue;
    }
    const [name, ...rest] = line.split(/\s+/);
    const flags: Record<string, ForgeFlagValue> = { ...(REGEN_FLAGS[name] ?? {}) };
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (!t.startsWith("--")) continue;
      const eq = t.indexOf("=");
      if (eq > 2) {
        flags[t.slice(2, eq)] = t.slice(eq + 1);
      } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        flags[t.slice(2)] = rest[++i];
      } else {
        flags[t.slice(2)] = true;
      }
    }
    owners.push({ path: p, command: name, flags });
  }
  return { owners, nonGenerated };
}
