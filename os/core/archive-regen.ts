/*
<MODULE_CONTRACT>
<purpose>docs.archive owner-regeneration (RFC-1528) — collect the generated artifacts
invalidated by archive moves and re-invoke their owner commands through
context.invoke. Owner selection is registry-driven: a command owns a generated
artifact when it declares it via generates[].path, or via a writes[] entry that
resolves to a generated file (marker, .generated. infix, or command:/generatedAt:
header convention — index.yaml/ecosystem.generated.yaml carry no GENERATED_MARKER
line). Manifest-generation logic itself is never duplicated here.</purpose>
<non-goals>
  <item>No generation logic — owners are invoked by name through the kernel port.</item>
  <item>Standalone forge CLI has no invoke port — degrade with a note, never block.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1528: close review findings — manifest-union command inventory for regen/preflight</item>
  <item>F-0126: tighten owner predicate — generates[] or all-generated writes[]; required flags must be REGEN_FLAGS-covered; excluded[] diagnostics</item>
  <item>RFC-1528: exclude non-generator commands from docs.archive owner regen (F-0126)</item>
  <item>RFC-1535: stageMovedPairs — self-staging helper for move pairs (F-0038)</item>
  <item>RFC-1602: defer docs.archive owner-regen to the integrate fold and stage bookkeeping atomically

docs.archive recorded ~12-minute inline owner regen blocking session end
(F-0212) and left pnpm-lock.yaml MM after its safety-net restore (F-0245).
The invalidated owner inventory now lands in .git/forge/deferred-regen.json
for flow.integrate's post-rebase fold to sweep (record cleared only when
every owner ran); bookkeeping pathspecs are validated before the first
git add, the lockfile restore gained its index-side counterpart, and a
post-staging sweep surfaces MM residue with the git show : remediation.

RFC-1602</item>
  <history>RFC-1528</history>
</CHANGE_SUMMARY>
*/

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { hasGeneratedMarker } from "../../src/utils/generated-marker.ts";
import { loadLiveCommandInventory } from "../../src/utils/command-inventory.ts";
import type {
  ExecResult,
  ForgeFlagValue,
  ForgeRegisteredCommandInfo,
  ForgeRuntimeContext,
} from "../../src/types.ts";

/** Per-owner flag overrides — generator commands that persist only under a flag. */
export const REGEN_FLAGS: Record<string, Record<string, ForgeFlagValue>> = {
  "rfc.index.generate": { write: true },
};

/**
 * Ordering contract: ecosystem.manifest.generate hashes the other generated
 * artifacts, so it always runs last among the invalidated owners.
 */
const MANIFEST_GENERATOR = "ecosystem.manifest.generate";

/** The invoking command can never be its own regen owner. */
const SELF_COMMAND = "docs.archive";

export interface ArchiveRegenCandidate {
  command: string;
  flags: Record<string, ForgeFlagValue>;
  artifactPaths: string[];
}

export interface ArchiveRegenOutcome {
  /** Workspace-relative paths owner invokes reported as modified. */
  regenerated: string[];
  /** Owner commands invoked. */
  invoked: string[];
  /** Candidate owners skipped because context.invoke is absent. */
  skipped: string[];
  /** Per-owner failures — reported, never fatal to the archive run. */
  failures: Array<{ command: string; error: string }>;
  /** Reads-matched commands excluded from ownership (F-0126 diagnostics). */
  excluded: Array<{ command: string; reason: RegenExcludeReason }>;
  /** Why regen did not invoke, when it did not invoke at all. */
  skipReason: "no-invoke" | "no-inventory" | null;
}

/** Generated-by-name: the `.generated.` infix convention (ecosystem.generated.yaml). */
export function isGeneratedPathName(relPath: string): boolean {
  return path.basename(relPath).includes(".generated.");
}

/**
 * Generated-by-content: GENERATED_MARKER/EDITABLE_GENERATED_MARKER, or the
 * self-describing YAML header (`command:` + `generatedAt:`) emitted by the
 * manifest family of generators (docs/rfcs/index.yaml carries no marker line).
 */
export function isGeneratedContent(content: string): boolean {
  if (hasGeneratedMarker(content)) return true;
  const head = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 10);
  return (
    head.some((line) => /^command:\s*\S/.test(line)) &&
    head.some((line) => /^generatedAt:/.test(line))
  );
}

/** Workspace-backed probe for declared writes[] paths. */
export function generatedPathProbe(workspaceRoot: string): (relPath: string) => boolean {
  return (relPath) => {
    if (isGeneratedPathName(relPath)) return true;
    if (relPath.includes("*")) return false;
    const abs = path.join(workspaceRoot, relPath);
    if (!existsSync(abs)) return false;
    try {
      return isGeneratedContent(readFileSync(abs, "utf8"));
    } catch {
      return false;
    }
  };
}

/** Why a reads-matched command was excluded from owner selection (F-0126). */
export type RegenExcludeReason = "mixed-writes" | "required-flags";

export interface ArchiveRegenSelection {
  candidates: ArchiveRegenCandidate[];
  /**
   * Commands whose reads[] intersected a moved path but that cannot act as
   * regen owners — diagnostics only, never invoked.
   */
  excluded: Array<{ command: string; reason: RegenExcludeReason }>;
}

/**
 * Pure selection: owners whose declared generated artifacts are invalidated by
 * the moved paths — i.e. the command reads at least one glob matching a moved
 * from/to path. Order: registry order with ecosystem.manifest.generate last.
 *
 * F-0126 ownership contract: a mutator that emits generated side-artifacts
 * among hand-authored writes (e.g. rfc.implement.stamp writing verification
 * envelopes alongside docs/rfcs/**\/*.md) is not a regen owner — ownership
 * requires an explicit generates[] declaration or a fully generated writes[]
 * surface. Batch regen invokes owners bare, so any required flag not covered
 * by REGEN_FLAGS excludes the command outright.
 */
export function collectInvalidatedGenerators(
  movedPaths: string[],
  commands: ForgeRegisteredCommandInfo[],
  isGeneratedPath: (relPath: string) => boolean,
): ArchiveRegenSelection {
  const candidates: ArchiveRegenCandidate[] = [];
  const excluded: ArchiveRegenSelection["excluded"] = [];
  for (const command of commands) {
    if (command.name === SELF_COMMAND) continue;
    const writes = command.writes ?? [];
    const generatedWrites = writes.filter((w) => isGeneratedPath(w));
    const declared = (command.generates ?? []).map((g) => g.path);
    if (declared.length === 0 && generatedWrites.length === 0) continue;
    const reads = command.reads ?? [];
    const invalidated = movedPaths.some((moved) =>
      reads.some((glob) => picomatch.isMatch(moved, glob)),
    );
    if (!invalidated) continue;
    if (declared.length === 0 && generatedWrites.length !== writes.length) {
      excluded.push({ command: command.name, reason: "mixed-writes" });
      continue;
    }
    const flags = REGEN_FLAGS[command.name] ?? {};
    const uncoveredRequired = Object.entries(command.flags ?? {}).some(
      ([flagName, spec]) => spec?.required === true && !(flagName in flags),
    );
    if (uncoveredRequired) {
      excluded.push({ command: command.name, reason: "required-flags" });
      continue;
    }
    candidates.push({
      command: command.name,
      flags,
      artifactPaths: [...declared, ...generatedWrites],
    });
  }
  return {
    candidates: candidates.sort((a, b) => {
      if (a.command === MANIFEST_GENERATOR) return 1;
      if (b.command === MANIFEST_GENERATOR) return -1;
      return 0;
    }),
    excluded,
  };
}

/**
 * AC-6 gate: owner regeneration fires only on a real run that moved files —
 * a `--dry-run` docs.archive is report-only and never invokes generators.
 */
export function shouldRunArchiveRegen(dryRun: boolean, totalMoved: number): boolean {
  return !dryRun && totalMoved > 0;
}

/**
 * Invoke seam: run each invalidated owner through context.invoke. Absent invoke
 * (standalone forge CLI) → all candidates skipped with a note, never a crash.
 */
export async function runArchiveRegen(options: {
  movedPaths: string[];
  context: ForgeRuntimeContext;
  isGeneratedPath?: (relPath: string) => boolean;
  /** Test seam — overrides the live inventory union (registry + command manifest). */
  commands?: ForgeRegisteredCommandInfo[];
}): Promise<ArchiveRegenOutcome> {
  const { movedPaths, context } = options;
  const commands =
    options.commands ?? loadLiveCommandInventory(context.workspaceRoot, context.commandRegistry);
  const probe = options.isGeneratedPath ?? generatedPathProbe(context.workspaceRoot);
  const { candidates, excluded } = collectInvalidatedGenerators(movedPaths, commands, probe);
  const outcome: ArchiveRegenOutcome = {
    regenerated: [],
    invoked: [],
    skipped: [],
    failures: [],
    excluded,
    skipReason: null,
  };

  if (!context.invoke || commands.length === 0) {
    outcome.skipped = candidates.map((c) => c.command);
    outcome.skipReason = !context.invoke ? "no-invoke" : "no-inventory";
    return outcome;
  }

  for (const candidate of candidates) {
    try {
      const result = await context.invoke(candidate.command, candidate.flags);
      if (result.ok === false || (result.exitCode !== undefined && result.exitCode !== 0)) {
        outcome.failures.push({
          command: candidate.command,
          error: result.summary ?? `exit code ${result.exitCode}`,
        });
        continue;
      }
      outcome.invoked.push(candidate.command);
      // Prefer the child's reported writes; fall back to the invalidated
      // declared paths so `regenerated` always names what refreshed (AC-7).
      const reported =
        result.filesModified && result.filesModified.length > 0
          ? result.filesModified
          : candidate.artifactPaths.filter((p) => !p.includes("*"));
      for (const modified of reported) {
        if (!outcome.regenerated.includes(modified)) outcome.regenerated.push(modified);
      }
    } catch (error) {
      outcome.failures.push({
        command: candidate.command,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}

/**
 * RFC-1535 (F-0038): self-staging — every moved pair lands BOTH sides in the
 * index (destination add + source delete) so the next commit captures the
 * move as one unit instead of a split add/delete across two commits.
 * `git add -A` on the union of moved from/to paths covers both sides; a
 * non-git or already-clean tree degrades to a warn-only outcome — the
 * commit-side EC-31 check is the safety net for any half-staged survivor.
 */
export async function stageMovedPairs(options: {
  movedPaths: string[];
  workspaceRoot: string;
  exec: (command: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;
}): Promise<{ staged: number; error?: string }> {
  const { movedPaths, workspaceRoot, exec } = options;
  if (movedPaths.length === 0) return { staged: 0 };
  try {
    const result = await exec("git", ["add", "-A", "--", ...movedPaths], {
      cwd: workspaceRoot,
    });
    if (result.exitCode !== 0) {
      return { staged: 0, error: result.stderr || `git add exit ${result.exitCode}` };
    }
    return { staged: movedPaths.length };
  } catch (error) {
    return { staged: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── RFC-1602 (F-0212/F-0245): deferred owner-regen + atomic bookkeeping ──
// docs.archive no longer invokes owner generators inline — it records the
// invalidated owner inventory for the integrate fold to sweep post-rebase.
// The record lives under the git common dir (.git/forge/) so every linked
// worktree sees the same file, and survives commits until consumed.

export interface DeferredRegenOwner {
  command: string;
  flags: Record<string, ForgeFlagValue>;
  artifactPaths: string[];
}

export interface DeferredRegenRecord {
  at: string;
  movedPaths: string[];
  owners: DeferredRegenOwner[];
}

export type RegenExec = (
  command: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<ExecResult>;

async function gitCommonDir(workspaceRoot: string, exec: RegenExec): Promise<string | null> {
  const result = await exec("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceRoot });
  if (result.exitCode !== 0) return null;
  const dir = result.stdout.trim();
  return dir.length === 0 ? null : path.resolve(workspaceRoot, dir);
}

export async function deferredRegenFilePath(
  workspaceRoot: string,
  exec: RegenExec,
): Promise<string | null> {
  const dir = await gitCommonDir(workspaceRoot, exec);
  return dir ? path.join(dir, "forge", "deferred-regen.json") : null;
}

/**
 * Merge-write the deferred owner inventory — a second archive run before the
 * next integrate unions owners (dedup by command) and moved paths rather than
 * clobbering the pending record.
 */
export async function recordDeferredRegen(options: {
  workspaceRoot: string;
  exec: RegenExec;
  movedPaths: string[];
  owners: DeferredRegenOwner[];
}): Promise<{ file: string } | null> {
  const file = await deferredRegenFilePath(options.workspaceRoot, options.exec);
  if (!file) return null;
  let existing: DeferredRegenRecord | null = null;
  try {
    existing = JSON.parse(readFileSync(file, "utf8")) as DeferredRegenRecord;
  } catch {
    // First record or unreadable — start fresh.
  }
  const owners = [...(existing?.owners ?? [])];
  for (const owner of options.owners) {
    if (!owners.some((o) => o.command === owner.command)) owners.push(owner);
  }
  const movedPaths = [...new Set([...(existing?.movedPaths ?? []), ...options.movedPaths])];
  mkdirSync(path.dirname(file), { recursive: true });
  const record: DeferredRegenRecord = { at: new Date().toISOString(), movedPaths, owners };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { file };
}

/**
 * Read the pending record — the integrate fold consumes it; `null` when no
 * archive deferred anything or the record is unreadable.
 */
export async function consumeDeferredRegen(options: {
  workspaceRoot: string;
  exec: RegenExec;
}): Promise<{ record: DeferredRegenRecord; file: string } | null> {
  const file = await deferredRegenFilePath(options.workspaceRoot, options.exec);
  if (!file || !existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as DeferredRegenRecord;
    return Array.isArray(record.owners) ? { record, file } : null;
  } catch {
    return null;
  }
}

export function clearDeferredRegen(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone — clearing is best-effort.
  }
}

/**
 * Pre-staging validation (AC-2): every bookkeeping path must be stageable —
 * tracked OR present on disk — before the first `git add`. An untracked
 * `missions/<id>`-class source makes `git add -A` refuse mid-set, which is
 * how the F-0245 partial staging happened.
 */
export async function findUnstageablePaths(options: {
  paths: string[];
  workspaceRoot: string;
  exec: RegenExec;
  exists: (relPath: string) => Promise<boolean>;
}): Promise<string[]> {
  const { paths, workspaceRoot, exec, exists } = options;
  const tracked = new Set(
    (await exec("git", ["ls-files"], { cwd: workspaceRoot })).stdout
      .split("\n")
      .filter((l) => l.length > 0),
  );
  const unstageable: string[] = [];
  for (const p of paths) {
    if (!tracked.has(p) && !(await exists(p))) unstageable.push(p);
  }
  return unstageable;
}

/**
 * Post-staging MM sweep (AC-4): bookkeeping paths where index and worktree
 * both diverge from HEAD (X≠' ' && Y∈{M,D}) — the staged-prune/HEAD-restore
 * residue. Each surfaced path carries the exact index→worktree remediation.
 */
export async function sweepMmResidue(options: {
  paths: string[];
  workspaceRoot: string;
  exec: RegenExec;
}): Promise<string[]> {
  const { paths, workspaceRoot, exec } = options;
  if (paths.length === 0) return [];
  const status = await exec("git", ["status", "--porcelain", "--", ...paths], {
    cwd: workspaceRoot,
  });
  const warnings: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.length < 3) continue;
    const [x, y] = [line[0], line[1]];
    if (x !== " " && x !== "?" && x !== "!" && (y === "M" || y === "D")) {
      const p = line.slice(3);
      warnings.push(`${p} left in ${x}${y} state — remediate with: git show :${p} > ${p}`);
    }
  }
  return warnings;
}
